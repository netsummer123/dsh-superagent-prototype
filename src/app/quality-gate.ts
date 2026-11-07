/**
 * The ticket quality gate: a host-run AI code review in front of a worker's `ready` report.
 *
 * It runs at one chokepoint (the `orchestrator_report` tool's `ready` branch) and never trusts the worker's own claim of
 * self-review. The review is an independent process (`ocr review`), a separate context and model from the worker, and observes
 * only the ticket's diff. See `dsh-superagent-AI-CodeReview质量门禁方案.md` for the design and the first-principles rationale.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Ticket } from '../core/index.ts'
import type { QualityGateConfig } from '../policy.ts'

const exec = promisify(execFile)

/** A single finding as `ocr review --format json` reports it. */
export interface Finding {
  path: string
  content: string
  start_line: number
  end_line: number
  category?: string
  severity?: string
  suggestion_code?: string
  existing_code?: string
}
/** The fields of `ocr review --format json` this gate reads; everything else is ignored. */
export interface OcrResult {
  status?: string
  comments?: Finding[]
  summary?: { files_reviewed?: number; comments?: number; total_tokens?: number; elapsed?: string; budget_exceeded?: boolean }
  tool_calls?: { total?: number; failure?: number }
  manifest?: {
    terminal_state?: string
    elapsed_ms?: number
    /**
     * Coverage fields are arrays of item descriptors in OCR >= 1.13 (e.g. `{ item_id, path, fingerprint }[]`) and were plain
     * counts in earlier builds. Accept both so a version bump cannot turn coverage into `NaN`.
     */
    coverage?: { selected?: number | unknown[]; completed?: number | unknown[]; reused?: number | unknown[];
      failed?: number | unknown[]; waived?: number | unknown[] }
    execution?: { ocr_version?: string; model?: string; rule_config_sha256?: string }
    input?: { resolved_base?: string; resolved_head?: string; source_artifact_sha256?: string }
  }
}
/** The persisted evidence of one gate run, keyed by a fingerprint of the reviewed work. */
export interface Receipt {
  fingerprint: string
  base: string
  head: string
  at: string
  /** `skipped` when the review could not run or there was nothing to review; `reviewed` when `ocr` produced a result. */
  outcome: 'reviewed' | 'skipped'
  reason?: string
  /** `pass`/`fail` only when reviewed; undefined for skipped. */
  pass?: boolean
  blocking: number
  counts: { critical: number; high: number; medium: number; low: number }
  status?: string
  tokens?: number
  elapsedMs?: number
  /** Human coverage percentage, e.g. `100%`, for the summary line. */
  coverageText?: string
  ocrVersion?: string
  model?: string
  /** The git repository the gate actually reviewed (may be a child of the ticket directory). */
  repository?: string
  /** Changed lines and the token budget actually passed to `ocr`, for auditing an adaptive budget. */
  diffLines?: number
  budget?: number
  /** Set when the first review exhausted its token budget and the gate retried at `--effort low`. */
  budgetRetries?: number
  /** Deterministic (zero-AI) checks: their names when failed, empty when clean. */
  deterministic: string[]
  findings: Finding[]
}
/** What the caller does with a receipt. */
export interface Verdict {
  mode: QualityGateConfig['mode']
  pass: boolean
  blocking: number
  receipt: Receipt
  /** A structured Input to hand back to the worker when the gate blocks handover; present only while retries remain. */
  input?: { text: string }
  /** True once the gate has turned this ticket back `maxAttempts` times: the host should escalate to a person. */
  exhausted: boolean
  /** The reviewer itself could not certify the change (missing repo/CLI, unreachable endpoint, timeout, unresolved base). */
  unavailable: boolean
  /** Whether the host must refuse `ready` for this verdict. `enforce` blocks everything; an unavailable reviewer blocks in any
   * mode when `onUnavailable=block`, while `observe` still only records findings. */
  blocksHandover: boolean
  /** A short line for the ready report's summary and the panel. */
  summary: string
}
/** Config the gate runs with, plus the ticket's directory inputs. */
export interface GateContext {
  ticket: Ticket
  config: QualityGateConfig
  /** How many times this ticket's ready report has already been turned back by the gate. */
  attempts: number
  signal?: AbortSignal
  /** Absolute directory the gate writes receipts under; defaults to the ticket directory. */
  receiptDir?: string
}

/** A receipt that records why the reviewer never ran. All of these are fail-closed candidates, unlike `no_reviewable_files`. */
export const UNAVAILABLE_REASONS = ['ocr_unavailable', 'no_git_repository', 'base_unresolved'] as const

/** Where the review runs and what diff it covers. */
export interface RepositoryLocation {
  /** Directory used as `cwd` for every git/ocr subprocess. */
  directory: string
  /** Commit the ticket's work branched from; empty when it could not be resolved. */
  base: string
  /** Set when no usable git repository could be found. */
  error?: string
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
const severityRank = (value: string | undefined): number => SEVERITY_ORDER[value ?? 'medium'] ?? 2

/** True when the gate should consider this ticket at all: enabled, and matching the project allowlist (empty = all). */
export function gateApplies(config: QualityGateConfig, ticket: Pick<Ticket, 'execution'>): boolean {
  if (config.mode === 'off') return false
  if (config.projects.length && !config.projects.includes(ticket.execution?.project ?? '')) return false
  return !!ticket.execution?.directory
}

/** The number of coverage items, whether OCR reports a count or an array of item descriptors. */
export function coverageCount(value: number | unknown[] | undefined): number {
  return typeof value === 'number' ? value : Array.isArray(value) ? value.length : 0
}

/** Parse an `ocr review --format json` payload defensively; unknown shapes yield an empty result rather than throwing. */
export function parseOcrResult(json: string): OcrResult {
  let value: unknown
  try { value = JSON.parse(json) } catch { return { status: 'failed', comments: [] } }
  const object = (value ?? {}) as Record<string, unknown>
  const comments = Array.isArray(object.comments) ? object.comments.filter(item => item && typeof item === 'object') as Finding[] : []
  return { ...(object as OcrResult), comments }
}

/** Count findings at or above the blocking severity, de-duplicated by (path, line, category). */
export function countBlocking(findings: readonly Finding[], onSeverity: QualityGateConfig['onSeverity']): {
  blocking: number
  counts: Receipt['counts']
} {
  const threshold = severityRank(onSeverity)
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  const seen = new Set<string>()
  let blocking = 0
  for (const finding of findings) {
    const severity = (finding.severity ?? 'medium').toLowerCase()
    if (severity in counts) counts[severity as keyof typeof counts] += 1
    const key = `${finding.path}:${finding.start_line ?? 0}:${finding.category ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    if (severityRank(severity) <= threshold) blocking += 1
  }
  return { blocking, counts }
}

/** True when a receipt records that the reviewer could not run, as opposed to there being nothing to review. */
export const reviewerUnavailable = (receipt: Receipt): boolean =>
  receipt.outcome === 'skipped' && UNAVAILABLE_REASONS.includes((receipt.reason ?? '') as typeof UNAVAILABLE_REASONS[number])

/**
 * Decide a receipt's verdict. Deterministic failures always block. An unavailable reviewer is fail-closed whenever
 * `onUnavailable=block`, independent of `mode`: an uncertified change must not be handed to a person even while `observe`
 * shadows findings. A run with no reviewable file passes.
 */
export function decide(receipt: Receipt, config: QualityGateConfig): { pass: boolean; blocking: number } {
  if (receipt.deterministic.length > 0) return { pass: false, blocking: receipt.blocking }
  if (receipt.outcome === 'skipped') {
    if (reviewerUnavailable(receipt) && config.onUnavailable === 'block') return { pass: false, blocking: 0 }
    return { pass: true, blocking: 0 }
  }
  const coverage = receipt.status === 'complete'
  const clean = receipt.blocking === 0
  return { pass: coverage && clean, blocking: receipt.blocking }
}

/** The Input handed back when the reviewer was unavailable and the gate is fail-closed. */
export function buildUnavailableInput(receipt: Receipt): string {
  const cause: Record<string, string> = {
    ocr_unavailable: 'ocr 未安装、端点不可达、限流或请求超时',
    no_git_repository: '在工单目录下找不到可用的 git 仓库（改动可能位于子目录）',
    base_unresolved: '无法确定审查起点 commit（无法推导 merge-base）',
  }
  return [
    '[质量门禁] 审查未能执行，本次改动未经 AI 审查，按配置不得交工。',
    `原因：${receipt.reason ?? 'ocr_unavailable'}（${cause[receipt.reason ?? ''] ?? '未知原因'}）。`,
    '要求：请人恢复审查条件（仓库目录、git 基线、模型端点、密钥、网络、版本）后让本工单重新提交 ready；不要绕过门禁、不要改动门禁配置或删除回执。',
  ].join('\n')
}

/** Format the findings into the Input text the worker receives when the gate blocks. */
export function buildFindingsInput(receipt: Receipt, config: QualityGateConfig): string {
  const blocking = receipt.findings
    .filter(item => severityRank(item.severity) <= severityRank(config.onSeverity))
    .slice(0, 20)
    .map(item => `- ${item.path}:${item.start_line ?? '?'} [${item.category ?? 'other'}/${item.severity ?? 'medium'}] ${item.content.split('\n')[0]}`)
  const det = receipt.deterministic.length ? `\n确定性检查未通过：${receipt.deterministic.join('、')}` : ''
  return [
    `[质量门禁] 审查未通过（ocr ${receipt.ocrVersion ?? '?'} · ${receipt.model ?? '?'} · ${receipt.tokens ?? '?'} token · ${Math.round((receipt.elapsedMs ?? 0) / 1000)}s）`,
    `阻断项（severity ≥ ${config.onSeverity}，共 ${receipt.blocking} 条）：`,
    ...(blocking.length ? blocking : ['- （无可定位行号的阻断项，详见回执）']),
    det,
    '要求：修复阻断项后重新提交 ready；若判定为误报，报告时在 summary 中逐条说明理由（不得静默跳过）。',
  ].filter(Boolean).join('\n')
}

/** A short human line for the ready report and the panel. */
export function summaryLine(receipt: Receipt): string {
  const sec = Math.round((receipt.elapsedMs ?? 0) / 1000)
  if (receipt.deterministic.length > 0) return `质量门禁：未通过（确定性检查：${receipt.deterministic.join('、')} · ${sec}s）`
  if (reviewerUnavailable(receipt)) return receipt.pass === false
    ? `质量门禁：未通过（审查器不可用：${receipt.reason} · 按配置不得交工 · ${sec}s）`
    : `质量门禁：跳过（审查器不可用：${receipt.reason} · ${sec}s）`
  if (receipt.outcome === 'skipped') return `质量门禁：跳过（${receipt.reason ?? '无内容'}）`
  const state = receipt.pass ? '通过' : '未通过'
  return `质量门禁：${state}（ocr ${receipt.ocrVersion ?? '?'} · 阻断 ${receipt.blocking} · 覆盖率 ${receipt.coverageText ?? '?'} · ${sec}s）`
}

/**
 * Token budget for a review. A fixed budget that is too small makes OCR stop at `partial` (which the gate treats as a failure).
 * Scale with the diff size, but never below the configured floor and never more than 8x it. ~2000 tokens per changed line is a
 * conservative estimate including the file context and code searches OCR performs; effort changes the number of review rounds.
 * A review that still exhausts the budget is retried once at `--effort low` (see `QualityGate.produce`), since tokens are
 * dominated by how eagerly the model explores rather than by diff size.
 */
export function adaptiveBudget(config: QualityGateConfig, diffLines: number): number {
  const effortFactor = config.effort === 'high' ? 1.4 : config.effort === 'low' ? 0.7 : 1
  const estimate = Math.ceil(diffLines * 1200 * effortFactor)
  return Math.min(Math.max(config.maxTokensBudget, estimate), config.maxTokensBudget * 8)
}

/** True when OCR stopped early because it hit the aggregate token budget. */
export function budgetExceeded(result: OcrResult): boolean {
  if (result.summary?.budget_exceeded === true) return true
  const failed = result.manifest?.coverage?.failed
  return Array.isArray(failed) && failed.some(item => (item as { classification?: string } | null)?.classification === 'budget')
}

/** Zero-AI checks over the diff between `base` and `head`, plus uncommitted changes: debug leftovers, hardcoded secrets. */
export async function deterministicChecks(directory: string, base: string | undefined, run: RunFn): Promise<string[]> {
  const failures: string[] = []
  const range = base ? [`${base}..HEAD`] : ['HEAD']
  const diff = await run('git', ['-C', directory, 'diff', '--unified=0', ...range], directory).catch(() => '')
  const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'))
  if (added.some(line => /\b(console\.log|debugger|pdb\.set_trace|binding\.pry)\b/.test(line) || /\bprint\(/.test(line))) failures.push('调试残留')
  if (added.some(line => /\b(TODO|FIXME|XXX)\b/.test(line))) failures.push('TODO/FIXME')
  if (added.some(line => /(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY)/.test(line))) failures.push('疑似硬编码密钥')
  return failures
}

/** Runs a program and returns stdout; rejects on failure. Injected so tests avoid real subprocesses. */
export type RunFn = (program: string, args: string[], cwd: string, env?: Record<string, string>) => Promise<string>

const defaultRun: RunFn = async (program, args, cwd, env) => {
  // On Windows the npm shims (`ocr`) and some git installs are `.cmd`, which Node cannot spawn directly; `shell: true` lets the
  // shell apply PATHEXT. The git/ocr arguments here are refs, flags and repository-relative paths (never absolute paths with
  // spaces), and the working directory travels through the `cwd` option rather than an argument, so shell concatenation is safe.
  const { stdout } = await exec(program, args, { cwd, maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32',
    env: { ...process.env, ...env } })
  return stdout
}

/** Environment the `ocr` child sees: the gate's own endpoint, never the worker's. `OCR_LLM_TOKEN` from the host overrides `token`. */
export function ocrEnvironment(llm: QualityGateConfig['llm']): Record<string, string> {
  const env: Record<string, string> = { OCR_LLM_PROTOCOL: llm.protocol, ...(llm.url ? { OCR_LLM_URL: llm.url } : {}),
    ...(llm.model ? { OCR_LLM_MODEL: llm.model } : {}) }
  if (llm.token) env.OCR_LLM_TOKEN = llm.token
  else if (process.env.OCR_LLM_TOKEN) env.OCR_LLM_TOKEN = process.env.OCR_LLM_TOKEN
  return env
}

const receiptPath = (dir: string, fingerprint: string): string => join(dir, '.dsh', 'review', `${fingerprint}.json`)

function readReceipt(dir: string, fingerprint: string): Receipt | undefined {
  try { return JSON.parse(readFileSync(receiptPath(dir, fingerprint), 'utf8')) as Receipt } catch { return undefined }
}

function writeReceipt(dir: string, receipt: Receipt): void {
  const path = receiptPath(dir, receipt.fingerprint)
  mkdirSync(join(dir, '.dsh', 'review'), { recursive: true })
  writeFileSync(path, JSON.stringify(receipt, null, 2))
}

/** Strip a command's trailing newline and surrounding whitespace. */
const clean = (value: string): string => value.trim()

/** Directories one or two levels below `root` that hold a `.git` file or directory. */
function childRepositories(root: string): string[] {
  const candidates: string[] = []
  const visit = (dir: string, depth: number): void => {
    if (depth > 2) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const child = join(dir, entry.name)
      if (existsSync(join(child, '.git'))) candidates.push(child)
      else visit(child, depth + 1)
    }
  }
  visit(root, 1)
  return candidates
}

/** Stable, short hash of the reviewed state. Includes the resolved repo/base and the review-affecting config, so a stale
 * `skipped` receipt cannot survive a fix to repository detection or a change of provider/effort/budget. */
function fingerprintOf(parts: string[]): string {
  let h1 = 0x811c9dc5, h2 = 0x1000193
  const text = parts.join('\n')
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'))
}

/** Reject after `ms`, racing the given promise so a hung child does not hold a worker slot forever. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('gate timed out')), ms) })])
  } finally { if (timer) clearTimeout(timer) }
}

/**
 * The gate proper. Resolves the real git repository (a project ticket may keep it in a child directory), derives the commit the
 * ticket branched from, scales the token budget to the diff, runs the deterministic checks and the AI review, persists a receipt,
 * and returns a verdict the caller acts on. Every failure is recorded as an explicit `skipped` reason, never a silent pass.
 */
export class QualityGate {
  private readonly run: RunFn
  constructor(run: RunFn = defaultRun) { this.run = run }

  /** Find the directory `git`/`ocr` must run in and the commit the review starts from. */
  async locateRepository(context: GateContext): Promise<RepositoryLocation> {
    const ticketDir = context.ticket.execution!.directory
    const recordedBase = context.ticket.execution?.base
    const isRepo = async (dir: string): Promise<boolean> => {
      const top = await this.run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], dir).then(clean).catch(() => '')
      return top.length > 0
    }
    let directory = ticketDir
    if (!await isRepo(ticketDir)) {
      // A project ticket may keep several checkouts (the real repo, a baseline worktree for comparison, samples). Prefer the
      // one that actually carries the ticket's unmerged commits; otherwise the newest commit wins. Never pick by name alone.
      const scored: { dir: string; ahead: number; at: number }[] = []
      for (const candidate of childRepositories(ticketDir)) {
        if (!await isRepo(candidate)) continue
        scored.push({ dir: candidate, ...await this.repositoryScore(candidate) })
      }
      scored.sort((a, b) => b.ahead - a.ahead || b.at - a.at || a.dir.localeCompare(b.dir))
      if (scored.length) directory = scored[0]!.dir
      if (directory === ticketDir) return { directory, base: '', error: 'no_git_repository' }
    }
    const head = await this.run('git', ['-C', directory, 'rev-parse', 'HEAD'], directory).then(clean).catch(() => '')
    if (!head) return { directory, base: '', error: 'no_git_repository' }
    const base = recordedBase || await this.inferBase(directory)
    return { directory, base }
  }

  /** How many commits `HEAD` leads the default branch by, and the timestamp of its latest commit. */
  private async repositoryScore(directory: string): Promise<{ ahead: number; at: number }> {
    let ahead = 0
    for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
      const exists = await this.run('git', ['-C', directory, 'rev-parse', '--verify', ref], directory).then(clean).catch(() => '')
      if (!exists) continue
      const count = await this.run('git', ['-C', directory, 'rev-list', '--count', `${ref}..HEAD`], directory).then(clean).catch(() => '')
      if (/^\d+$/.test(count)) { ahead = Number(count); break }
    }
    const at = Number(await this.run('git', ['-C', directory, 'log', '-1', '--format=%ct'], directory).then(clean).catch(() => '0')) || 0
    return { ahead, at }
  }

  /**
   * Derive the branch point for an in-place ticket that has no recorded `execution.base`. Remote refs can point at an older
   * history than the local default branch, so collect every candidate and pick the merge-base closest to `HEAD` (fewest
   * commits in `<candidate>..HEAD`); otherwise the review would cover thousands of unrelated lines.
   */
  private async inferBase(directory: string): Promise<string> {
    const candidates: { sha: string; ahead: number }[] = []
    for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
      const sha = await this.run('git', ['-C', directory, 'merge-base', ref, 'HEAD'], directory).then(clean).catch(() => '')
      if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue
      const count = await this.run('git', ['-C', directory, 'rev-list', '--count', `${sha}..HEAD`], directory).then(clean).catch(() => '')
      candidates.push({ sha, ahead: /^\d+$/.test(count) ? Number(count) : Number.MAX_SAFE_INTEGER })
    }
    candidates.sort((a, b) => a.ahead - b.ahead)
    return candidates[0]?.sha ?? ''
  }

  /** Changed lines in `base..HEAD`, used to size the token budget. */
  private async diffLines(directory: string, base: string): Promise<number> {
    if (!base) return 0
    const out = await this.run('git', ['-C', directory, 'diff', '--numstat', `${base}..HEAD`], directory).catch(() => '')
    return out.split('\n').reduce((sum, line) => {
      const match = /^(\d+)\t(\d+)\t/.exec(line)
      return match ? sum + Number(match[1]) + Number(match[2]) : sum
    }, 0)
  }

  async check(context: GateContext): Promise<Verdict> {
    const { config, ticket } = context
    const ticketDir = ticket.execution!.directory
    const dir = context.receiptDir ?? ticketDir
    const location = await this.locateRepository(context)
    const head = location.error ? '' : await this.run('git', ['-C', location.directory, 'rev-parse', 'HEAD'], location.directory).then(clean).catch(() => '')
    const dirty = location.error ? '' : await this.run('git', ['-C', location.directory, 'status', '--porcelain'], location.directory).catch(() => '')
    const fingerprint = fingerprintOf([location.error ?? '', location.directory, location.base, head, clean(dirty),
      config.provider, config.effort, String(config.maxTokensBudget)])

    const cached = readReceipt(dir, fingerprint)
    const receipt = cached ?? await this.produce(context, { fingerprint, ...location, head })
    if (!cached) writeReceipt(dir, receipt)

    const verdict = decide(receipt, config)
    receipt.pass = verdict.pass
    const unavailable = reviewerUnavailable(receipt)
    const exhausted = context.attempts >= config.maxAttempts
    // An unavailable reviewer blocks handover in any mode; `observe` only shadows findings.
    const blocksHandover = !verdict.pass && (config.mode === 'enforce' || (unavailable && config.onUnavailable === 'block'))
    const gate: Verdict = { mode: config.mode, pass: verdict.pass, blocking: verdict.blocking, receipt,
      exhausted, unavailable, blocksHandover, summary: summaryLine(receipt) }
    if (blocksHandover && !exhausted) {
      gate.input = { text: unavailable ? buildUnavailableInput(receipt) : buildFindingsInput(receipt, config) }
    }
    return gate
  }

  private async produce(context: GateContext, ids: RepositoryLocation & { fingerprint: string; head: string }): Promise<Receipt> {
    const { config } = context
    const baseReceipt = (over: Partial<Receipt>): Receipt => ({ fingerprint: ids.fingerprint, base: ids.base, head: ids.head,
      at: new Date().toISOString(), outcome: 'skipped', blocking: 0,
      counts: { critical: 0, high: 0, medium: 0, low: 0 }, deterministic: [], findings: [],
      ...(ids.directory ? { repository: ids.directory } : {}), ...over })

    if (ids.error) return baseReceipt({ reason: ids.error })
    const deterministic = await deterministicChecks(ids.directory, ids.base || undefined, this.run)
    if (config.provider === 'deterministic') return baseReceipt({ reason: 'deterministic-only', deterministic })
    // Without a base the AI review would silently fall back to workspace mode and miss already-committed work.
    if (!ids.base) return baseReceipt({ reason: 'base_unresolved', deterministic })

    const rangeFlags = ['--from', ids.base, '--to', ids.head]
    const preview = await this.run('ocr', ['review', '--preview', '--format', 'json', ...rangeFlags], ids.directory)
      .then(text => JSON.parse(text) as { files?: { will_review?: boolean }[] }).catch(() => undefined)
    if (preview && !preview.files?.some(file => file.will_review)) return baseReceipt({ reason: 'no_reviewable_files', deterministic })

    const lines = await this.diffLines(ids.directory, ids.base)
    const budget = adaptiveBudget(config, lines)
    const timeoutMs = config.timeoutMinutes * 60_000
    const runReview = async (tokens: number, effort: QualityGateConfig['effort']): Promise<OcrResult | undefined> => {
      const args = ['review', '--format', 'json', '--audience', 'agent', '--effort', effort,
        '--max-tokens-budget', String(tokens), '--concurrency', '4', ...rangeFlags]
      const json = await withTimeout(this.run('ocr', args, ids.directory, ocrEnvironment(config.llm)), timeoutMs)
        .catch(() => undefined)
      return json ? parseOcrResult(json) : undefined
    }
    let result = await runReview(budget, config.effort)
    if (!result) return baseReceipt({ reason: 'ocr_unavailable', deterministic, diffLines: lines, budget })
    let budgetRetries = 0
    // OCR's budget is a soft cap, and an eager model can burn it on exploration whatever the estimate. Rather than doubling an
    // already-large budget (tokens are the unpredictable cost), retry once at `--effort low`, which cuts the review rounds.
    if (budgetExceeded(result) && config.effort !== 'low') {
      const retried = await runReview(budget, 'low')
      if (retried) { result = retried; budgetRetries = 1 }
    }

    const findings = result.comments ?? []
    const { blocking, counts } = countBlocking(findings, config.onSeverity)
    const status = result.manifest?.terminal_state ?? result.status ?? 'unknown'
    const coverage = result.manifest?.coverage
    const selected = coverageCount(coverage?.selected), completed = coverageCount(coverage?.completed)
    const failed = coverageCount(coverage?.failed)
    const coverageRate = selected > 0 ? completed / selected : 1
    const receipt = baseReceipt({ outcome: 'reviewed', status, blocking, counts, findings, deterministic,
      diffLines: lines, budget, budgetRetries, tokens: result.summary?.total_tokens, elapsedMs: result.manifest?.elapsed_ms,
      coverageText: `${Math.round(coverageRate * 100)}%`, ocrVersion: result.manifest?.execution?.ocr_version,
      model: result.manifest?.execution?.model })
    if (failed > 0) { receipt.status = 'partial'; receipt.pass = false }
    if (status !== 'complete' && status !== 'partial') receipt.status = status
    if (coverageRate < config.minCoverage) { receipt.status = 'partial'; receipt.pass = false }
    receipt.pass = decide(receipt, config).pass
    return receipt
  }
}
