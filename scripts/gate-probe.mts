/**
 * Manual end-to-end probe of the quality gate against a real temp repo and the real `ocr` CLI.
 * Run (no npx needed, Node >= 22.18 strips TS types natively):
 *   node --experimental-strip-types scripts/gate-probe.mts
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QualityGate, type RunFn } from '../src/app/quality-gate.ts'
import type { Ticket } from '../src/core/index.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 }).trim()

function makeRepo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gate-probe-'))
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
  id: 'probe', title: 'probe', decisionId: 'd', mandate: {} as Ticket['mandate'], channels: [], assignments: [], inputs: [],
  undelivered: [], origin: { triggerId: '1', triggerIds: ['1'] }, createdAt: '', updatedAt: '',
  execution: { name: 'probe', directory: dir, assignment: '', base },
} as Ticket)

/** A complete config value without importing policy.ts (keeps this probe dependency-free beyond node builtins). */
const baseConfig = () => ({
  mode: 'enforce' as const, onSeverity: 'medium' as const, provider: 'deterministic' as const, effort: 'low' as const,
  maxTokensBudget: 120_000, timeoutMinutes: 10, minCoverage: 0.9, projects: [] as string[], maxAttempts: 2,
  onUnavailable: 'block' as const, ocrVersion: '1.13.6', llm: { url: '', model: '', protocol: 'openai' as const, token: '', timeoutSec: 300 },
})
const config = (over: Record<string, unknown> = {}) => ({ ...baseConfig(), ...over }) as never

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

// ---- Case 1: deterministic catches debug leftovers + a hardcoded key ----
console.log('case 1: deterministic blocking')
{
  const { dir, base } = makeRepo()
  writeFileSync(join(dir, 'app.js'),
    'export function add(a, b) {\n  console.log("debug", a, b)\n  const key = "sk-abcdef0123456789ABCDEF"\n  return a + b\n}\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'add debug + key')
  const v = await new QualityGate().check({ ticket: ticketFor(dir, base), config: config(), attempts: 0 })
  check('deterministic blocks debug/key', v.pass === false && v.receipt.deterministic.length > 0, JSON.stringify(v.receipt.deterministic))
  check('enforce hands back findings Input', !!v.input && v.input.text.includes('质量门禁'))
  rmSync(dir, { recursive: true, force: true })
}

// ---- Case 2: clean change passes deterministic ----
console.log('case 2: deterministic clean')
{
  const { dir, base } = makeRepo()
  writeFileSync(join(dir, 'app.js'), 'export function add(a, b) {\n  return Number(a) + Number(b)\n}\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'clean tweak')
  const v = await new QualityGate().check({ ticket: ticketFor(dir, base), config: config(), attempts: 0 })
  check('clean change passes deterministic', v.pass === true && v.receipt.deterministic.length === 0, JSON.stringify(v.receipt.deterministic))
  rmSync(dir, { recursive: true, force: true })
}

// ---- Case 3: real `ocr review` through the configured endpoint ----
console.log('case 3: real ocr review (up to 10 min)')
{
  const { dir, base } = makeRepo()
  writeFileSync(join(dir, 'app.js'), 'export function add(a, b) {\n  return a - b\n}\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'wrong operator')
  const model = process.env.GATE_PROBE_MODEL ?? 'deepseek/deepseek-flash'
  const llm = { url: process.env.GATE_PROBE_URL ?? 'http://127.0.0.1:3425', model,
    protocol: 'openai' as const,
    token: process.env.GATE_PROBE_TOKEN ?? '', timeoutSec: 300 }
  console.log(`  model=${model}`)
  const v = await new QualityGate().check({ ticket: ticketFor(dir, base), config: config({ provider: 'ocr', effort: 'low', llm }), attempts: 0 })
  const r = v.receipt
  check('ocr produced a real review receipt', r.outcome === 'reviewed',
    `outcome=${r.outcome} reason=${r.reason ?? '-'} status=${r.status ?? '-'} findings=${r.findings.length} tokens=${r.tokens ?? '-'} ms=${r.elapsedMs ?? '-'}`)
  if (r.outcome === 'reviewed') {
    check('ocr terminal state complete/partial', r.status === 'complete' || r.status === 'partial', `status=${r.status}`)
    check('ocr v1.13.6 recorded in receipt', r.ocrVersion === 'v1.13.6', `ocrVersion=${r.ocrVersion}`)
    check('ocr token usage recorded', (r.tokens ?? 0) > 0, `tokens=${r.tokens}`)
  }
  rmSync(dir, { recursive: true, force: true })
}

// ---- Case 4: fail-closed when the reviewer is unavailable ----
console.log('case 4: reviewer unavailable must not hand over work')
{
  const { dir, base } = makeRepo()
  writeFileSync(join(dir, 'app.js'), 'export function add(a, b) {\n  return Number(a) + Number(b)\n}\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'clean tweak')
  const broken: RunFn = async (program, args) => {
    if (program === 'ocr') throw new Error('endpoint down')
    return execFileSync(program, args, { encoding: 'utf8', maxBuffer: 1 << 26 })
  }
  const v = await new QualityGate(broken).check({ ticket: ticketFor(dir, base), config: config({ provider: 'ocr' }), attempts: 0 })
  check('unavailable reviewer blocks ready', v.pass === false && v.unavailable === true && v.blocksHandover === true, `reason=${v.receipt.reason}`)
  check('unavailable reviewer hands back a restore Input', !!v.input && v.input.text.includes('审查未能执行'))
  // Fix 4: an unavailable reviewer is fail-closed even in observe (observe only shadows findings).
  check('observe also blocks an unavailable reviewer', (await new QualityGate(broken).check({
    ticket: ticketFor(dir, base), config: config({ provider: 'ocr', mode: 'observe' }), attempts: 0 })).blocksHandover === true)
  // An explicit opt-out still allows a pass.
  check('onUnavailable=pass still degrades', (await new QualityGate(broken).check({
    ticket: ticketFor(dir, base), config: config({ provider: 'ocr', mode: 'observe', onUnavailable: 'pass' }), attempts: 0 })).pass === true)
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
