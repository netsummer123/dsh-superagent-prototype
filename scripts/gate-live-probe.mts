/**
 * Probe the quality gate with the *live* settings from the running SuperAgent panel.
 * Run: node --experimental-strip-types scripts/gate-live-probe.mts
 *
 * Unlike gate-probe.mts (fixed config), this reads `blocks.qualityGate` over the management API so it tests exactly what
 * the operator configured, including mode / provider / effort / budget / onUnavailable.
 */
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { QualityGate, type RunFn } from '../src/app/quality-gate.ts'
import type { QualityGateConfig } from '../src/policy.ts'
import type { Ticket } from '../src/core/index.ts'

type Config = QualityGateConfig

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const URL_FILE = resolve(ROOT, '..', 'dsh-superagent-panel-win.url')
const PANEL_URL = readFileSync(URL_FILE, 'utf8').trim()
const ORIGIN = new URL(PANEL_URL).origin

async function api(path: string, method: string, body?: unknown, cookie?: string): Promise<{ status: number; cookie: string; json: any }> {
  const data = body ? JSON.stringify(body) : null
  const headers: Record<string, string> = { 'x-orchestrator-request': '1', origin: ORIGIN }
  if (data) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  if (data) headers['content-length'] = String(Buffer.byteLength(data))
  return new Promise((res, rej) => {
    const req = http.request(ORIGIN + path, { method, headers }, resp => {
      let text = ''
      resp.on('data', c => text += c)
      resp.on('end', () => {
        let json: any = undefined
        try { json = JSON.parse(text) } catch { /* non-JSON response */ }
        res({ status: resp.statusCode ?? 0, cookie: (resp.headers['set-cookie'] ?? []).map(v => v.split(';')[0]).join('; '), json })
      })
    })
    req.on('error', rej)
    if (data) req.write(data)
    req.end()
  })
}

async function liveConfig(): Promise<{ config: Config; revision: number; token: string }> {
  const url = readFileSync(URL_FILE, 'utf8').trim()
  const token = new URL(url).searchParams.get('token') ?? ''
  const auth = await api('/?token=' + token, 'GET')
  const cookie = auth.cookie
  const settings = await api('/orchestrator/api/settings', 'GET', undefined, cookie)
  if (settings.status !== 200) throw new Error(`GET settings -> ${settings.status} ${JSON.stringify(settings.json)}`)
  const block = settings.json.blocks.qualityGate
  return { config: block.value as Config, revision: block.revision, token }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 }).trim()
function makeRepo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gate-live-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'probe@example.com')
  git(dir, 'config', 'user.name', 'probe')
  writeFileSync(join(dir, 'app.js'), 'export function add(a, b) {\n  return a + b\n}\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base')
  const base = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'checkout', '-qb', 'agent/probe')
  return { dir, base }
}
const ticketFor = (dir: string, base: string): Ticket => ({
  id: 'live-probe', title: 'probe', decisionId: 'd', mandate: {} as Ticket['mandate'], channels: [], assignments: [], inputs: [],
  undelivered: [], origin: { triggerId: '1', triggerIds: ['1'] }, createdAt: '', updatedAt: '',
  execution: { name: 'live-probe', directory: dir, assignment: '', base },
} as Ticket)

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

const { config, revision } = await liveConfig()
const enforcing = config.mode === 'enforce'
console.log('=== 当前门禁配置 (rev ' + revision + ') ===')
console.log(JSON.stringify({ mode: config.mode, provider: config.provider, onSeverity: config.onSeverity, effort: config.effort,
  maxTokensBudget: config.maxTokensBudget, timeoutMinutes: config.timeoutMinutes, minCoverage: config.minCoverage,
  maxAttempts: config.maxAttempts, onUnavailable: config.onUnavailable, ocrVersion: config.ocrVersion,
  llm: { url: config.llm.url, model: config.llm.model, protocol: config.llm.protocol, tokenSet: !!config.llm.token } }, null, 2))

// ---- A: real ocr with the live config; assert the verdict is consistent with the evidence ----
console.log('\n[A] 真实 ocr review（按当前 effort + budget）')
{
  const { dir, base } = makeRepo()
  // A genuinely behaviour-preserving change: only a comment is added.
  writeFileSync(join(dir, 'app.js'), '// add returns the arithmetic sum of its two arguments\nexport function add(a, b) {\n  return a + b\n}\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'comment only')
  const v = await new QualityGate().check({ ticket: ticketFor(dir, base), config, attempts: 0 })
  const r = v.receipt
  console.log(`    outcome=${r.outcome} status=${r.status ?? '-'} coverage=${r.coverageText ?? '-'} findings=${r.findings.length} tokens=${r.tokens ?? '-'} ms=${r.elapsedMs ?? '-'} pass=${v.pass} blocking=${v.blocking}`)
  check('A: 真实 AI 审查已运行', r.outcome === 'reviewed', `reason=${r.reason ?? '-'}`)
  if (r.outcome === 'reviewed') {
    check('A: 回执记录 ocr v1.13.6', r.ocrVersion === 'v1.13.6', `ocrVersion=${r.ocrVersion}`)
    check('A: 覆盖率不是 NaN', !/NaN/.test(r.coverageText ?? ''), `coverageText=${r.coverageText}`)
    // The invariant that matters: no blocking finding + complete review + full coverage => pass; otherwise block.
    const expected = r.status === 'complete' && v.blocking === 0 && !/NaN/.test(r.coverageText ?? '')
    check('A: 判定与审查证据一致', v.pass === expected, `expected=${expected} pass=${v.pass}`)
  }
  rmSync(dir, { recursive: true, force: true })
}

// ---- B: a real defect (deterministic + AI) ----
console.log('\n[B] 含缺陷改动 / 应当阻断')
{
  const { dir, base } = makeRepo()
  writeFileSync(join(dir, 'app.js'),
    'export function add(a, b) {\n  console.log("debug")\n  const key = "sk-abcdef0123456789"\n  return a - b\n}\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'debug + key + wrong operator')
  const v = await new QualityGate().check({ ticket: ticketFor(dir, base), config, attempts: 0 })
  console.log(`    deterministic=${JSON.stringify(v.receipt.deterministic)} aiFindings=${v.receipt.findings.length} pass=${v.pass} mode=${config.mode}`)
  check('B: 审查确实执行并记录了缺陷', v.receipt.deterministic.length > 0 || v.receipt.findings.length > 0)
  // `decide` reports the raw verdict regardless of mode; only `enforce` turns it into a blocked ready report + an Input.
  check('B: 门禁判定为不通过', v.pass === false)
  check('B: 回灌 Input 与模式一致', enforcing ? !!v.input : !v.input,
    enforcing ? 'enforce 应回灌 findings' : 'observe 只记录不回灌（影子观测）')
  rmSync(dir, { recursive: true, force: true })
}

// ---- C: reviewer unavailable -> fail-closed ----
console.log('\n[C] 审查器不可用 / fail-closed')
{
  const { dir, base } = makeRepo()
  writeFileSync(join(dir, 'app.js'), 'export function add(a, b) {\n  return Number(a) + Number(b)\n}\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'clean tweak')
  const broken: RunFn = async (program, args) => {
    if (program === 'ocr') throw new Error('endpoint down')
    return execFileSync(program, args, { encoding: 'utf8', maxBuffer: 1 << 26 })
  }
  const v = await new QualityGate(broken).check({ ticket: ticketFor(dir, base), config, attempts: 0 })
  console.log(`    reason=${v.receipt.reason} unavailable=${v.unavailable} exhausted=${v.exhausted} pass=${v.pass} mode=${config.mode} onUnavailable=${config.onUnavailable}`)
  // Fix 4: an unavailable reviewer is fail-closed in ANY mode when onUnavailable=block; only findings stay shadow-only.
  const shouldBlock = config.onUnavailable === 'block'
  check('C: 审查器不可用不得交工（独立于 mode）', v.pass === false && v.blocksHandover === true,
    `mode=${config.mode} onUnavailable=${config.onUnavailable}`)
  check('C: 回灌"恢复审查条件"Input', shouldBlock ? !!v.input && v.input.text.includes('审查未能执行') : !v.input)
  if (!shouldBlock) console.log('    注意：onUnavailable=pass，审查器不可用也不阻断。')
  const w = await new QualityGate(broken).check({ ticket: ticketFor(dir, base), config: { ...config, onUnavailable: 'pass' }, attempts: 0 })
  check('C: 显式 onUnavailable=pass 仍放行', w.pass === true && w.blocksHandover === false)
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
