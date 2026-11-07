/** Diagnose why `ocr` fails from the gate's default runner. Run: node --experimental-strip-types scripts/gate-diag.mts */
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QualityGate, type RunFn } from '../src/app/quality-gate.ts'
import type { Ticket } from '../src/core/index.ts'

const exec = promisify(execFile)
const diagRun: RunFn = async (program, args, cwd, env) => {
  console.log(`RUN ${program} ${args.join(' ')}`)
  try {
    const { stdout } = await exec(program, args, { cwd, maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32', env: { ...process.env, ...env } })
    console.log(`  ok, ${stdout.length} bytes`)
    return stdout
  } catch (e: any) {
    console.log(`  FAILED code=${e?.code} errno=${e?.errno} stderr=${String(e?.stderr ?? '').slice(0, 500)} msg=${String(e?.message).slice(0, 300)}`)
    throw e
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const dir = mkdtempSync(join(tmpdir(), 'gate-diag-'))
git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 'a@b'); git(dir, 'config', 'user.name', 'a')
writeFileSync(join(dir, 'app.js'), 'export function add(a,b){return a+b}\n')
git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base')
const base = git(dir, 'rev-parse', 'HEAD')
git(dir, 'checkout', '-qb', 'agent/x')
writeFileSync(join(dir, 'app.js'), 'export function add(a,b){return a-b}\n')
git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'wrong')

const ticket = { id: 'd', title: 'd', decisionId: 'd', mandate: {} as Ticket['mandate'], channels: [], assignments: [], inputs: [],
  undelivered: [], origin: { triggerId: '1', triggerIds: ['1'] }, createdAt: '', updatedAt: '',
  execution: { name: 'd', directory: dir, assignment: '', base } } as Ticket
const llm = { url: 'http://127.0.0.1:3425', model: 'workbuddy/deepseek-v4.1-flash', protocol: 'openai' as const,
  token: process.env.GATE_PROBE_TOKEN ?? '', timeoutSec: 300 }
const config = { mode: 'enforce', onSeverity: 'medium', provider: 'ocr', effort: 'low', maxTokensBudget: 120000,
  timeoutMinutes: 10, minCoverage: 0.9, projects: [], maxAttempts: 2, ocrVersion: '1.13.6', llm } as never

const v = await new QualityGate(diagRun).check({ ticket, config, attempts: 0, receiptDir: dir })
console.log('VERDICT', JSON.stringify({ pass: v.pass, outcome: v.receipt.outcome, reason: v.receipt.reason,
  status: v.receipt.status, findings: v.receipt.findings.length, ocrVersion: v.receipt.ocrVersion }))
rmSync(dir, { recursive: true, force: true })
