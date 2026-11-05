/** Subprocess wrapper for running gh, lark-cli, and git commands under the deployment's configured accounts. */
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { defaultFetcher, type Deployment, type Fetcher } from '../deployment.ts'
import { sameName } from './text.ts'

const exec = promisify(execFile)
const TIMEOUT_MS = 90_000
/**
 * Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, and exit status without echoing command arguments.
 * Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
 */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number) { super(message) }
}
/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
export function commandError(error: unknown, program = 'command'): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const exitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try { parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed }
    catch { /* Non-JSON CLI diagnostics are retained below. */ }
    const code = parsed?.error?.code
    if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode)
    // `gh` exits non-zero on HTTP errors (such as `gh: Not Found (HTTP 404)`) and on `gh: HTTP 304`, which ETag polling relies on.
    if (stderr) return new CliError(stderr.slice(0, 2000), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined, exitCode)
  }
  return new CliError(`${basename(program)} ${ended(error)}`, undefined, exitCode)
}
function ended(error: unknown): string {
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // `execFile` timeout terminates the process with SIGTERM and sets `killed: true`.
  if (killed && signal === 'SIGTERM') return `timed out after ${TIMEOUT_MS / 1000} s`
  if (signal) return `was stopped by ${signal}`
  if (typeof code === 'number') return `exited with code ${code}`
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
}
export interface Tally { skipped: number }
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  if (tally) tally.skipped += list.length - items.length
  return items
}
/** Rewrites Feishu error 232011 (bot not in chat) with remediation instructions. */
function membership(error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== 232011) return error
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  return new CliError(hint, error.code, error.exitCode)
}
/**
 * Executes gh, lark-cli, and git subprocesses with deployment account credentials, timeouts, and abort signals.
 * Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
export class Commands {
  /** HTTP client for DingTalk; the default is the global `fetch`, and tests replace it to answer DingTalk calls. */
  fetcher: Fetcher = defaultFetcher
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables overriding `process.env` for every command (such as isolated git settings).
   */
  constructor(private readonly resolved: () => Deployment, private readonly environment: Record<string, string | undefined>, private readonly signal: AbortSignal) {}
  get deployment(): Deployment { return this.resolved() }
  get repository(): string { return this.deployment.repository }
  withSignal(signal?: AbortSignal): Commands {
    if (!signal) return this
    const next = new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal]))
    next.fetcher = this.fetcher
    return next
  }
  async run(program: string, args: string[], cwd?: string, extraEnv?: Record<string, string>): Promise<string> {
    try {
      const { stdout } = await exec(program, args, { cwd, signal: this.signal, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...this.environment, ...extraEnv, GH_PROMPT_DISABLED: '1', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
      return stdout
    } catch (error) { throw commandError(error, program) }
  }
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  async gh<T>(args: string[]): Promise<T> { return JSON.parse(await this.run(this.deployment.github.cli, args)) as T }
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') return this.run(this.deployment.github.cli, ['api', this.path(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.gh(['api', this.path(path), ...flags]))
  }
  /** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z.array(z.array(z.unknown())).parse(await this.gh(['api', this.path(path), '--paginate', '--slurp']))
    return validItems(item, pages.flat(), tally)
  }
  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`
  }
  /**
   * Runs the Feishu bot's `lark-cli` and returns the JSON `data` payload.
   * @throws CliError with Feishu's error code on failure (rewriting 232011 when the bot is not in the chat).
   */
  async lark<T>(args: string[], cwd?: string): Promise<T> {
    const bot = this.deployment.feishu
    if (!bot) throw new Error('The Feishu Source has no working bot CLI')
    const output = await this.run(bot.cli, [...args, '--as', 'bot', '--format', 'json'], cwd)
      .catch((error: unknown) => { throw membership(error) })
    const result = JSON.parse(output) as { ok: boolean; data: T; error?: { code?: number; message?: string } }
    const code = result.error?.code
    if (!result.ok) throw membership(new CliError(`${result.error?.message ?? 'Feishu command failed'}${code ? ` (${code})` : ''}`, code))
    return result.data
  }
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  async git(args: string[], cwd: string): Promise<string> { return this.run('git', args, cwd) }
  /**
   * Runs the agent's `glab` CLI against the configured GitLab host and parses its JSON output. The host travels in `GITLAB_HOST`
   * because `glab --hostname` must follow `api` and rejects a `host:port`, while the environment variable accepts it anywhere.
   * @throws CliError carrying GitLab's HTTP status as `code` on failure.
   */
  async glab<T>(args: string[]): Promise<T> {
    return JSON.parse(await this.run(this.gitlabCli(), args, undefined, this.gitlabEnv())) as T
  }
  /**
   * Calls the GitLab API v4 on a path within a configured project. Paths are relative to the project's API root (`issues`,
   * `merge_requests/12/notes`, …); a path already rooted at that project is accepted too. Anything naming another project is
   * refused, so a caller cannot reach beyond the projects the operator configured.
   * @param request - optional method and JSON body, for a write (GitLab takes writes as form fields, sent here as `-f key=value`).
   * @throws CliError carrying GitLab's HTTP status as `code` on failure.
   */
  async gitlabApi<T = unknown>(project: string, path: string, request?: { method: 'POST' | 'PUT'; body: Record<string, unknown> }): Promise<T> {
    const root = this.gitlabRoot(project)
    const full = path === '' ? root : path.startsWith('projects/') ? path : `${root}/${path.replace(/^\/+/, '')}`
    if (full !== root && !full.startsWith(`${root}/`) && !full.startsWith(`${root}?`)) throw new Error('GitLab calls are restricted to the configured project')
    const flags = request ? ['--method', request.method, ...Object.entries(request.body).flatMap(([key, value]) => ['-f', `${key}=${String(value)}`])] : []
    return JSON.parse(await this.run(this.gitlabCli(), ['api', ...flags, full], undefined, this.gitlabEnv())) as T
  }
  /** Fetches a GitLab list by page (GitLab caps `per_page` at 100), following `X-Next-Page` until it is empty. */
  async gitlabPages<T>(project: string, path: string, perPage = 100): Promise<unknown[]> {
    const separator = path.includes('?') ? '&' : '?'
    const items: unknown[] = []
    for (let page = 1; page <= 100; page++) {
      const batch = await this.gitlabApi<unknown>(project, `${path}${separator}page=${page}&per_page=${perPage}`)
      if (!Array.isArray(batch)) throw new Error('A paginated GitLab read returned a non-list')
      items.push(...batch)
      if (batch.length < perPage) break
    }
    return items
  }
  /** The glab CLI of the configured GitLab host, or a clear error when the Source names none. */
  private gitlabCli(): string {
    const gitlab = this.deployment.gitlab
    if (!gitlab) throw new Error('The GitLab Source has no working glab CLI')
    return gitlab.cli
  }
  /** The environment a glab call runs with: `GITLAB_HOST` pins the configured host (with its port), and an optional config dir isolates its credentials. */
  private gitlabEnv(): Record<string, string> {
    const gitlab = this.deployment.gitlab
    if (!gitlab) throw new Error('The GitLab Source has no working glab CLI')
    return { GITLAB_HOST: gitlab.host, ...(gitlab.configDir ? { GLAB_CONFIG_DIR: gitlab.configDir } : {}) }
  }
  /** The API root of a configured project, refusing one the operator did not configure. */
  private gitlabRoot(project: string): string {
    const gitlab = this.deployment.gitlab
    if (!gitlab) throw new Error('The GitLab Source has no working glab CLI')
    if (!gitlab.projects.some(item => sameName(item.path, project))) throw new Error('GitLab calls are restricted to the configured projects')
    return `projects/${encodeURIComponent(project)}`
  }
  /**
   * Calls the DingTalk open API as the configured enterprise app, returning its JSON body.
   * A token is fetched once and cached in memory per AppKey; an expired-token answer drops the cache and retries the call
   * once. A body that reports `errcode != 0` throws a `CliError` carrying that code, which channels read to tell a gone
   * conversation from a retryable failure.
   * @param path - a path such as `/v1.0/robot/oToMessages/batchSend`, appended to the API base.
   */
  async dingtalk(path: string, body?: unknown, method: 'GET' | 'POST' = body === undefined ? 'GET' : 'POST'): Promise<unknown> {
    const url = `https://api.dingtalk.com${path}`
    const send = async (token: string) => {
      const headers: Record<string, string> = { 'x-acs-dingtalk-access-token': token }
      if (body !== undefined) headers['content-type'] = 'application/json'
      return this.fetcher({ url, method, headers, ...body !== undefined ? { body: JSON.stringify(body) } : {} })
    }
    try { return this.dingtalkBody(await send(await this.dingtalkToken()), path) }
    catch (error) {
      if (!staleToken(error)) throw error
      // The cached token expired or was revoked; drop it, fetch a fresh one, and try the same call once more.
      tokenCache.delete(this.deployment.dingtalk?.appKey ?? '')
      return this.dingtalkBody(await send(await this.dingtalkToken()), path)
    }
  }
  /** POSTs a message to a session webhook (which carries its own credential in the URL); returns `'gone'` for an expired or removed one. */
  async dingtalkWebhook(url: string, body: unknown): Promise<'sent' | 'gone'> {
    const response = await this.fetcher({ url, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    let value: { errcode?: number; errmsg?: string } | undefined
    try { value = JSON.parse(response.text) as typeof value } catch { /* Non-JSON; treated as a failure below. */ }
    if (response.status >= 200 && response.status < 300 && (value?.errcode ?? 0) === 0) return 'sent'
    // 310000 "invalid session webhook" / 300006 "session expired" mean the callback window closed; a new reply API call is needed.
    if (value && (value.errcode === 310000 || value.errcode === 300006 || /session|expire|invalid/i.test(value.errmsg ?? ''))) return 'gone'
    throw new CliError(`${value?.errmsg ?? 'DingTalk webhook failed'}${value?.errcode ? ` (${value.errcode})` : ''} (HTTP ${response.status})`, value?.errcode, response.status)
  }
  private dingtalkBody(response: { status: number; text: string }, path: string): unknown {
    let value: { errcode?: number; errmsg?: string; [key: string]: unknown } | undefined
    try { value = JSON.parse(response.text) as typeof value } catch { /* Non-JSON is reported below. */ }
    if (response.status < 200 || response.status >= 300) {
      throw new CliError(`${value?.errmsg ?? `HTTP ${response.status}`}${value?.errcode ? ` (${value.errcode})` : ''}`, value?.errcode, response.status)
    }
    if (value && typeof value.errcode === 'number' && value.errcode !== 0) {
      throw new CliError(`${value.errmsg ?? 'DingTalk command failed'} (${value.errcode})`, value.errcode)
    }
    return value
  }
  /** Obtains (and caches for 100 minutes) an access token for the configured DingTalk app. */
  private async dingtalkToken(): Promise<string> {
    const bot = this.deployment.dingtalk
    if (!bot) throw new Error('The DingTalk Source has no working app')
    const cached = tokenCache.get(bot.appKey)
    if (cached && cached.expiresAt > Date.now()) return cached.token
    const response = await this.fetcher({ url: 'https://api.dingtalk.com/v1.0/oauth2/accessToken', method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appKey: bot.appKey, appSecret: bot.appSecret }) })
    const parsed = z.object({ accessToken: z.string().min(1) }).safeParse(JSON.parse(response.text) as unknown)
    if (!parsed.success) throw new CliError(`DingTalk accessToken failed (HTTP ${response.status})`, undefined, response.status)
    tokenCache.set(bot.appKey, { token: parsed.data.accessToken, expiresAt: Date.now() + 100 * 60_000 })
    return parsed.data.accessToken
  }
}
/** In-process DingTalk access tokens by AppKey; the process is the single holder of these credentials, so one cache suffices. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>()
/** True when a failure means the access token is stale (HTTP 401, or DingTalk's invalid-token `errcode` 40014): refetch it and retry. */
const staleToken = (error: unknown): boolean => error instanceof CliError
  && (error.exitCode === 401 || error.code === 40014 || /token.*(invalid|expired)|invalid.*token/i.test(error.message))
