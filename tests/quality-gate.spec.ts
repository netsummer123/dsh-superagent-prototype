import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adaptiveBudget, budgetExceeded, countBlocking, coverageCount, decide, gateApplies, ocrEnvironment, parseOcrResult, QualityGate,
  reviewerUnavailable, summaryLine, type Receipt, type RunFn } from '../src/app/quality-gate.ts'
import { QualityGateConfigSchema } from '../src/policy.ts'
import type { Ticket } from '../src/core/index.ts'

const config = (over: Partial<ReturnType<typeof QualityGateConfigSchema.parse>> = {}) => QualityGateConfigSchema.parse({ mode: 'enforce', ...over })

/** A fake run: routes by program+first arg so tests never spawn a real process. */
function fakeRun(routes: { git?: Record<string, string>; ocr?: (args: string[]) => string; onOcr?: (args: string[], env?: Record<string, string>) => void }): RunFn {
  return async (program, args, _cwd, env) => {
    if (program === 'git') {
      const key = args.includes('rev-parse') ? 'head' : args.includes('status') ? 'status' : args.includes('diff') ? 'diff' : 'other'
      return routes.git?.[key] ?? ''
    }
    if (program === 'ocr') {
      routes.onOcr?.(args, env)
      if (args.includes('--preview')) return routes.git?.preview ?? JSON.stringify({ files: [{ will_review: true }] })
      return routes.ocr?.(args) ?? JSON.stringify({ status: 'complete', comments: [] })
    }
    return ''
  }
}

const ticket = (over: Partial<Ticket['execution']> = {}): Ticket => ({
  id: 't-1', title: 'x', decisionId: 'd', mandate: {} as Ticket['mandate'], channels: [], assignments: [], inputs: [], undelivered: [],
  origin: { triggerId: '1', triggerIds: ['1'] }, createdAt: '', updatedAt: '', execution: { name: 't-1', directory: '/tmp/t', assignment: '', base: 'abc123', ...over },
}) as Ticket

describe('quality-gate helpers', () => {
  it('gateApplies respects mode, project allowlist, and a directory', () => {
    expect(gateApplies(config({ mode: 'off' }), ticket())).toBe(false)
    expect(gateApplies(config({ projects: ['p1'] }), ticket({ project: 'p2' }))).toBe(false)
    expect(gateApplies(config({ projects: ['p1'] }), ticket({ project: 'p1' }))).toBe(true)
    expect(gateApplies(config(), ticket({ directory: '' }))).toBe(false)
  })

  it('parseOcrResult tolerates non-JSON and missing comments', () => {
    expect(parseOcrResult('not json').comments).toEqual([])
    expect(parseOcrResult(JSON.stringify({ status: 'complete', comments: [{ path: 'a' }, null, 3] })).comments).toHaveLength(1)
  })

  it('countBlocking counts at/above threshold and de-dups by path/line/category', () => {
    const findings = [
      { path: 'a', content: '', start_line: 1, end_line: 1, severity: 'critical', category: 'security' },
      { path: 'a', content: '', start_line: 1, end_line: 1, severity: 'critical', category: 'security' }, // duplicate
      { path: 'b', content: '', start_line: 2, end_line: 2, severity: 'low' },
      { path: 'c', content: '', start_line: 3, end_line: 3 }, // severity missing -> medium
    ]
    expect(countBlocking(findings, 'critical')).toMatchObject({ blocking: 1, counts: { critical: 2, low: 1, medium: 1 } })
    expect(countBlocking(findings, 'medium').blocking).toBe(2) // critical + medium
    expect(countBlocking(findings, 'high').counts.low).toBe(1)
  })

  it('coverageCount accepts both the legacy numeric counts and OCR 1.13 arrays of item descriptors', () => {
    expect(coverageCount(3)).toBe(3)
    expect(coverageCount([{ item_id: 'a' }, { item_id: 'b' }])).toBe(2)
    expect(coverageCount(undefined)).toBe(0)
    expect(coverageCount([])).toBe(0)
    // Guard the real regression: a v1.13 manifest must not produce a NaN coverage percentage.
    expect(`${Math.round((coverageCount([{ item_id: 'a' }]) / coverageCount([{ item_id: 'a' }])) * 100)}%`).toBe('100%')
  })

  it('decide passes skipped and clean complete runs, blocks non-complete or blocking findings', () => {
    const base: Receipt = { fingerprint: 'f', base: '', head: '', at: '', outcome: 'reviewed', blocking: 0,
      counts: { critical: 0, high: 0, medium: 0, low: 0 }, deterministic: [], findings: [], status: 'complete' }
    expect(decide({ ...base, outcome: 'skipped' }, config())).toEqual({ pass: true, blocking: 0 })
    expect(decide(base, config()).pass).toBe(true)
    expect(decide({ ...base, status: 'partial' }, config()).pass).toBe(false)
    expect(decide({ ...base, blocking: 1 }, config()).pass).toBe(false)
    expect(decide({ ...base, deterministic: ['调试残留'] }, config()).pass).toBe(false)
    // A deterministic failure blocks even when the run is 'skipped' (the deterministic-only provider, or nothing reviewable).
    expect(decide({ ...base, outcome: 'skipped', deterministic: ['疑似硬编码密钥'] }, config())).toEqual({ pass: false, blocking: 0 })
    expect(decide({ ...base, outcome: 'skipped', deterministic: [] }, config())).toEqual({ pass: true, blocking: 0 })
  })

  it('decide is fail-closed when the reviewer is unavailable, unless explicitly configured otherwise', () => {
    const r: Receipt = { fingerprint: 'f', base: '', head: '', at: '', outcome: 'skipped', reason: 'ocr_unavailable',
      blocking: 0, counts: { critical: 0, high: 0, medium: 0, low: 0 }, deterministic: [], findings: [] }
    // Default: enforce + onUnavailable='block' -> an uncertified change may not be handed over.
    expect(decide(r, config())).toEqual({ pass: false, blocking: 0 })
    expect(decide(r, config({ onUnavailable: 'block' })).pass).toBe(false)
    // Explicit opt-out degrades to the deterministic checks.
    expect(decide(r, config({ onUnavailable: 'pass' })).pass).toBe(true)
    // An unavailable reviewer is fail-closed in any mode (including observe) when onUnavailable=block.
    expect(decide(r, config({ mode: 'observe' })).pass).toBe(false)
    // Only an explicit opt-out degrades to the deterministic checks.
    expect(decide(r, config({ mode: 'observe', onUnavailable: 'pass' })).pass).toBe(true)
    // Other skip reasons are not a missing reviewer.
    expect(decide({ ...r, reason: 'no_reviewable_files' }, config()).pass).toBe(true)
    expect(decide({ ...r, reason: 'deterministic-only' }, config()).pass).toBe(true)
    // A deterministic failure still wins over an unavailable reviewer.
    expect(decide({ ...r, deterministic: ['调试残留'] }, config({ onUnavailable: 'pass' })).pass).toBe(false)
  })

  it('ocrEnvironment maps the gate llm to OCR_LLM_* and prefers a token', () => {
    expect(ocrEnvironment({ url: 'https://gw/v1', model: 'm', protocol: 'openai', token: 'tok', timeoutSec: 300 }))
      .toMatchObject({ OCR_LLM_URL: 'https://gw/v1', OCR_LLM_MODEL: 'm', OCR_LLM_PROTOCOL: 'openai', OCR_LLM_TOKEN: 'tok' })
  })

  it('summaryLine reports state and blocked count', () => {
    const r: Receipt = { fingerprint: 'f', base: '', head: '', at: '', outcome: 'reviewed', pass: false, blocking: 2, counts: { critical: 2, high: 0, medium: 0, low: 0 }, deterministic: [], findings: [], ocrVersion: '1.13.6', elapsedMs: 3000, coverageText: '100%' }
    expect(summaryLine(r)).toContain('未通过')
    expect(summaryLine({ ...r, outcome: 'skipped', reason: 'no_reviewable_files' })).toContain('跳过')
    expect(summaryLine({ ...r, outcome: 'skipped', reason: 'ocr_unavailable', pass: false })).toContain('不得交工')
  })
})

describe('QualityGate.check', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'qg-'))

  it('short-circuits when preview finds nothing reviewable, and caches the receipt', async () => {
    const d = dir(); try {
      const run = fakeRun({ git: { head: 'h1', status: '', preview: JSON.stringify({ files: [{ will_review: false }] }) } })
      const gate = new QualityGate(run)
      const v = await gate.check({ ticket: ticket(), config: config(), attempts: 0, receiptDir: d })
      expect(v.pass).toBe(true)
      expect(v.receipt.reason).toBe('no_reviewable_files')
      // A second check hits the cache: the ocr preview must not run again.
      const spy = vi.fn(run); const gate2 = new QualityGate(spy)
      await gate2.check({ ticket: ticket(), config: config(), attempts: 0, receiptDir: d })
      expect(spy).not.toHaveBeenCalledWith('ocr', expect.anything(), expect.anything(), expect.anything())
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('passes a clean complete review', async () => {
    const d = dir(); try {
      const gate = new QualityGate(fakeRun({ git: { head: 'h', status: '' }, ocr: () => JSON.stringify({ status: 'complete', comments: [], manifest: { terminal_state: 'complete', coverage: { selected: 1, completed: 1 }, execution: { ocr_version: '1.13.6', model: 'm' }, elapsed_ms: 1000 } }) }))
      const v = await gate.check({ ticket: ticket(), config: config(), attempts: 0, receiptDir: d })
      expect(v.pass).toBe(true)
      expect(v.receipt.ocrVersion).toBe('1.13.6')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('passes a clean complete review with OCR 1.13 array-shaped coverage (no NaN)', async () => {
    const d = dir(); try {
      const item = { item_id: 'a', path: 'app.js', fingerprint: 'x' }
      const gate = new QualityGate(fakeRun({ git: { head: 'h', status: '' }, ocr: () => JSON.stringify({ status: 'complete', comments: [],
        manifest: { terminal_state: 'complete', coverage: { selected: [item], completed: [item], reused: [], failed: [], waived: [] },
          execution: { ocr_version: 'v1.13.6', model: 'm' }, elapsed_ms: 1000 } }) }))
      const v = await gate.check({ ticket: ticket(), config: config(), attempts: 0, receiptDir: d })
      expect(v.pass).toBe(true)
      expect(v.receipt.coverageText).toBe('100%')
      expect(v.summary).not.toContain('NaN')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('treats failed coverage items as an incomplete review even when terminal_state is complete', async () => {
    const d = dir(); try {
      const gate = new QualityGate(fakeRun({ git: { head: 'h', status: '' }, ocr: () => JSON.stringify({ status: 'complete', comments: [],
        manifest: { terminal_state: 'complete', coverage: { selected: [{ item_id: 'a' }, { item_id: 'b' }], completed: [{ item_id: 'a' }], failed: [{ item_id: 'b' }] },
          execution: { ocr_version: 'v1.13.6' } } }) }))
      const v = await gate.check({ ticket: ticket(), config: config(), attempts: 0, receiptDir: d })
      expect(v.pass).toBe(false)
      expect(v.receipt.status).toBe('partial')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('blocks a critical finding and hands back an Input under enforce', async () => {
    const d = dir(); try {
      const gate = new QualityGate(fakeRun({ git: { head: 'h', status: '' }, ocr: () => JSON.stringify({ status: 'complete',
        comments: [{ path: 'src/a.ts', content: 'hardcoded key', start_line: 4, end_line: 4, severity: 'critical', category: 'security' }],
        manifest: { terminal_state: 'complete', coverage: { selected: 1, completed: 1 }, execution: { ocr_version: '1.13.6' } } }) }))
      const v = await gate.check({ ticket: ticket(), config: config(), attempts: 0, receiptDir: d })
      expect(v.pass).toBe(false)
      expect(v.blocking).toBe(1)
      expect(v.input?.text).toContain('src/a.ts:4')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('does not hand back an Input once attempts reach maxAttempts', async () => {
    const d = dir(); try {
      const gate = new QualityGate(fakeRun({ git: { head: 'h', status: '' }, ocr: () => JSON.stringify({ status: 'complete',
        comments: [{ path: 'a', content: 'x', start_line: 1, end_line: 1, severity: 'critical' }], manifest: { terminal_state: 'complete' } }) }))
      const v = await gate.check({ ticket: ticket(), config: config({ maxAttempts: 2 }), attempts: 2, receiptDir: d })
      expect(v.pass).toBe(false)
      expect(v.input).toBeUndefined()
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('blocks a deterministic-only run that finds a debug leftover, and hands back an Input', async () => {
    const d = dir(); try {
      const gate = new QualityGate(fakeRun({ git: { head: 'h', status: '',
        diff: '+  console.log("debug")\n+  const key = "sk-abcdef0123456789"\n' } }))
      const v = await gate.check({ ticket: ticket(), config: config({ provider: 'deterministic' }), attempts: 0, receiptDir: d })
      expect(v.pass).toBe(false)
      expect(v.receipt.outcome).toBe('skipped') // no model was invoked
      expect(v.receipt.deterministic.length).toBeGreaterThan(0)
      expect(v.input?.text).toContain('确定性检查')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('passes a deterministic-only run with a clean diff', async () => {
    const d = dir(); try {
      const gate = new QualityGate(fakeRun({ git: { head: 'h', status: '', diff: '+  return Number(a) + Number(b)\n' } }))
      const v = await gate.check({ ticket: ticket(), config: config({ provider: 'deterministic' }), attempts: 0, receiptDir: d })
      expect(v.pass).toBe(true)
      expect(v.receipt.deterministic).toEqual([])
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('is fail-closed when ocr is unavailable: blocks ready and hands back a restore-the-endpoint Input', async () => {
    const d = dir(); let seenEnv: Record<string, string> | undefined
    try {
      const gate = new QualityGate(fakeRun({ git: { head: 'h', status: '' }, ocr: () => { throw new Error('no endpoint') },
        onOcr: (_a, env) => { seenEnv = env } }))
      const v = await gate.check({ ticket: ticket(), config: config({ llm: { url: 'https://gw/v1', model: 'm', protocol: 'openai', token: 't', timeoutSec: 300 } }), attempts: 0, receiptDir: d })
      expect(v.pass).toBe(false)
      expect(v.unavailable).toBe(true)
      expect(v.receipt.reason).toBe('ocr_unavailable')
      expect(v.summary).toContain('不得交工')
      expect(v.input?.text).toContain('审查未能执行')
      expect(v.input?.text).toContain('不要绕过门禁')
      expect(seenEnv).toMatchObject({ OCR_LLM_URL: 'https://gw/v1', OCR_LLM_TOKEN: 't' })
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('honours onUnavailable=pass and marks a spent retry budget as exhausted', async () => {
    const d = dir(); try {
      const gate = new QualityGate(fakeRun({ git: { head: 'h', status: '' }, ocr: () => { throw new Error('no endpoint') } }))
      const v = await gate.check({ ticket: ticket(), config: config({ onUnavailable: 'pass' }), attempts: 0, receiptDir: d })
      expect(v.pass).toBe(true)
      expect(v.receipt.reason).toBe('ocr_unavailable')
      expect(v.summary).toContain('跳过')
      // A second run with the same fingerprint hits the cached receipt; a spent budget is reported for escalation.
      const w = await gate.check({ ticket: ticket(), config: config({ maxAttempts: 2 }), attempts: 2, receiptDir: d })
      expect(w.pass).toBe(false)
      expect(w.exhausted).toBe(true)
      expect(w.input).toBeUndefined() // no more worker Input: the host escalates to a person
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('blocks a partial review (coverage below minCoverage)', async () => {
    const d = dir(); try {
      const gate = new QualityGate(fakeRun({ git: { head: 'h', status: '' }, ocr: () => JSON.stringify({ status: 'complete', comments: [],
        manifest: { terminal_state: 'complete', coverage: { selected: 10, completed: 2 }, execution: { ocr_version: '1.13.6' } } }) }))
      const v = await gate.check({ ticket: ticket(), config: config(), attempts: 0, receiptDir: d })
      expect(v.pass).toBe(false)
      expect(v.receipt.status).toBe('partial')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

/** A run that models an in-place project ticket: the ticket directory is not a repo, the real repo is a child `repo/`. */
function repoRun(opts: { repoDir: string | string[]; hasBase?: boolean; ocr?: (args: string[]) => string }): RunFn {
  const dirs = Array.isArray(opts.repoDir) ? opts.repoDir : [opts.repoDir]
  return async (program, args, cwd) => {
    if (program === 'git') {
      if (args.includes('rev-parse') && args.includes('--show-toplevel')) {
        if (dirs.includes(cwd)) return cwd
        throw new Error('not a git repository')
      }
      if (args.includes('rev-parse')) return 'headsha'
      if (args.includes('rev-parse') && args.includes('--verify')) return 'abc123def4567890'
      if (args.includes('rev-list')) return cwd.endsWith('repo') ? '2' : '0'
      if (args.includes('log')) return cwd.endsWith('repo') ? '1700000000' : '1600000000'
      if (args.includes('merge-base')) return opts.hasBase === false ? '' : 'abc123def4567890'
      if (args.includes('status')) return ''
      if (args.includes('diff') && args.includes('--numstat')) return '100\t20\tapp.js\n'
      if (args.includes('diff')) return '+  const x = 1\n'
      return ''
    }
    if (program === 'ocr') {
      if (args.includes('--preview')) return JSON.stringify({ files: [{ will_review: true }] })
      return opts.ocr?.(args) ?? JSON.stringify({ status: 'complete', comments: [],
        manifest: { terminal_state: 'complete', coverage: { selected: [{}], completed: [{}] }, execution: { ocr_version: 'v1.13.6' } } })
    }
    return ''
  }
}
const childTicket = (root: string): Ticket => ticket({ directory: root, base: '' })

describe('fixes 1-4', () => {
  const root = () => mkdtempSync(join(tmpdir(), 'qg-repo-'))

  it('3: the token budget scales with the diff but stays within the configured floor and 8x cap', () => {
    const c = config({ effort: 'medium', maxTokensBudget: 120_000 })
    expect(adaptiveBudget(c, 10)).toBe(120_000)                 // floor
    expect(adaptiveBudget(c, 200)).toBe(240_000)                // 200 * 1200
    expect(adaptiveBudget(c, 10_000)).toBe(960_000)             // capped at 8x
    expect(adaptiveBudget(config({ effort: 'high', maxTokensBudget: 120_000 }), 200)).toBe(336_000)
    expect(adaptiveBudget(config({ effort: 'low', maxTokensBudget: 120_000 }), 200)).toBe(168_000)
  })

  it('3: budgetExceeded recognises both the summary flag and a budget-classified failed coverage item', () => {
    expect(budgetExceeded({ summary: { budget_exceeded: true } })).toBe(true)
    expect(budgetExceeded({ manifest: { coverage: { failed: [{ classification: 'budget' }] } } })).toBe(true)
    expect(budgetExceeded({ manifest: { coverage: { failed: [{ classification: 'tool_error' }] } } })).toBe(false)
    expect(budgetExceeded({ status: 'complete' })).toBe(false)
  })

  it('3: a budget-exhausted review is retried once at --effort low', async () => {
    const d = root(); try {
      const seenEffort: string[] = []
      const run = fakeRun({ git: { head: 'h', status: '' }, ocr: args => {
        const effort = args[args.indexOf('--effort') + 1] ?? ''
        seenEffort.push(effort)
        if (seenEffort.length === 1) return JSON.stringify({ status: 'partial', comments: [],
          summary: { budget_exceeded: true, total_tokens: 281227 },
          manifest: { terminal_state: 'partial', coverage: { selected: [1, 2], completed: [1], failed: [{ classification: 'budget' }] } } })
        return JSON.stringify({ status: 'complete', comments: [],
          manifest: { terminal_state: 'complete', coverage: { selected: [1, 2], completed: [1, 2], failed: [] }, execution: { ocr_version: 'v1.13.6' } } })
      } })
      const v = await new QualityGate(run).check({ ticket: ticket(), config: config({ effort: 'medium' }), attempts: 0, receiptDir: d })
      expect(seenEffort).toHaveLength(2)
      expect(seenEffort[0]).toBe('medium')
      expect(seenEffort[1]).toBe('low') // retried at low to cut review rounds
      expect(v.receipt.budgetRetries).toBe(1)
      expect(v.receipt.status).toBe('complete')
      expect(v.pass).toBe(true)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('1+2: finds a repo in a child directory, derives merge-base, and really reviews', async () => {
    const d = root(); try {
      const repo = join(d, 'repo'); mkdirSync(join(repo, '.git'), { recursive: true })
      const gate = new QualityGate(repoRun({ repoDir: repo }))
      const v = await gate.check({ ticket: childTicket(d), config: config({ mode: 'observe' }), attempts: 0, receiptDir: d })
      expect(v.receipt.reason).toBeUndefined()
      expect(v.receipt.repository).toBe(repo)
      expect(v.receipt.base).toBe('abc123def4567890')
      expect(v.receipt.outcome).toBe('reviewed')
      expect(v.receipt.diffLines).toBe(120)
      expect(v.receipt.budget).toBe(adaptiveBudget(config(), 120))
      expect(v.receipt.status).toBe('complete')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('1: prefers the checkout carrying the ticket commits over a baseline worktree', async () => {
    const d = root(); try {
      const baseline = join(d, 'baseline'), repo = join(d, 'repo')
      mkdirSync(join(baseline, '.git'), { recursive: true }); mkdirSync(join(repo, '.git'), { recursive: true })
      const v = await new QualityGate(repoRun({ repoDir: [baseline, repo] }))
        .check({ ticket: childTicket(d), config: config({ mode: 'observe' }), attempts: 0, receiptDir: d })
      expect(v.receipt.repository).toBe(repo)
      expect(v.receipt.outcome).toBe('reviewed')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('1: a ticket directory with no repository at all is recorded, never silently passed', async () => {
    const d = root(); try {
      const v = await new QualityGate(repoRun({ repoDir: join(d, 'repo') }))
        .check({ ticket: childTicket(d), config: config({ mode: 'observe' }), attempts: 0, receiptDir: d })
      expect(v.receipt.reason).toBe('no_git_repository')
      expect(v.receipt.outcome).toBe('skipped')
      expect(reviewerUnavailable(v.receipt)).toBe(true)
      expect(v.receipt.head).toBe('')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('2: a review with no derivable base is not silently downgraded to workspace mode', async () => {
    const d = root(); try {
      const repo = join(d, 'repo'); mkdirSync(join(repo, '.git'), { recursive: true })
      const v = await new QualityGate(repoRun({ repoDir: repo, hasBase: false }))
        .check({ ticket: childTicket(d), config: config({ mode: 'observe' }), attempts: 0, receiptDir: d })
      expect(v.receipt.reason).toBe('base_unresolved')
      expect(reviewerUnavailable(v.receipt)).toBe(true)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('4: an unavailable reviewer blocks handover even in observe, while findings stay shadow-only', async () => {
    const d = root(); try {
      // Unavailable: no repo at all.
      const blocked = await new QualityGate(repoRun({ repoDir: join(d, 'repo') }))
        .check({ ticket: childTicket(d), config: config({ mode: 'observe' }), attempts: 0, receiptDir: d })
      expect(blocked.pass).toBe(false)
      expect(blocked.unavailable).toBe(true)
      expect(blocked.blocksHandover).toBe(true)
      expect(blocked.input?.text).toContain('审查未能执行')

      // Findings in observe: verdict fails but the host must NOT refuse ready.
      const repo = join(d, 'repo'); mkdirSync(join(repo, '.git'), { recursive: true })
      const shadow = await new QualityGate(repoRun({ repoDir: repo, ocr: () => JSON.stringify({ status: 'complete',
        comments: [{ path: 'app.js', content: 'bug', start_line: 1, end_line: 1, severity: 'critical' }],
        manifest: { terminal_state: 'complete', coverage: { selected: [{}], completed: [{}] }, execution: { ocr_version: 'v1.13.6' } } }) }))
        .check({ ticket: childTicket(d), config: config({ mode: 'observe' }), attempts: 0, receiptDir: d })
      expect(shadow.pass).toBe(false)
      expect(shadow.blocksHandover).toBe(false)
      expect(shadow.input).toBeUndefined()

      // Explicit opt-out still allows a pass when the reviewer is unavailable.
      const optedOut = await new QualityGate(repoRun({ repoDir: join(d, 'none') }))
        .check({ ticket: childTicket(d), config: config({ mode: 'observe', onUnavailable: 'pass' }), attempts: 0, receiptDir: d })
      expect(optedOut.pass).toBe(true)
      expect(optedOut.blocksHandover).toBe(false)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})
