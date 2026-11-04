/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { ABSOLUTE_PATH, assertNativeAbsolute, executableNames, isCommandName, isWindows, stringEnvironment } from './infra/platform.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** An absolute path on either platform; its native form is checked where the path is used, so one saved config reads the same everywhere. */
const absolute = (description: string) => s.string().pattern(ABSOLUTE_PATH).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  // The schema accepts either platform's shape so a saved config travels; here the path is actually used, so it must be native.
  assertNativeAbsolute('stateDir', stateDir)
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** DingTalk bot credentials: an enterprise internal app's AppKey and AppSecret, exchanged for an access token at setup and on demand. */
export const DingtalkBotSchema = z.object({ appKey: z.string().trim().default(''), appSecret: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape),
  dingtalk: Object.keys(DingtalkBotSchema.shape) }

export interface Deployment extends Machine {
  repository: string
  github: { cli: string; login: string; noreply: string }
  feishu?: FeishuBot
  dingtalk?: DingtalkBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }
export interface DingtalkBot { appKey: string; appSecret: string; robotCode: string; name: string }

/**
 * Resolve a command name or absolute path to an executable file, ignoring the worker shim directory.
 * On Windows a bare name is tried with each `PATHEXT` extension, because the CLI there is `gh.exe` rather than `gh`.
 */
export function executable(name: string, path: string, exclude?: string): string {
  if (!isAbsolute(name) && !isCommandName(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const names = isAbsolute(name) ? [name] : executableNames(name)
  const dirs = isAbsolute(name) ? [''] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude)))
  for (const dir of dirs) {
    for (const candidate of names.map(item => dir ? join(dir, item) : item)) {
      try {
        if (!statSync(candidate).isFile()) continue
        // Windows has no execute bit; a readable file with a known extension is what the platform runs.
        if (!isWindows) accessSync(candidate, constants.X_OK)
        return candidate
      } catch { /* Not an executable file here; try the next extension or PATH directory. */ }
    }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  // POSIX prefixes `PATH` with the `env` tool; Windows has no `env`, so the runtime receives the environment itself.
  return isWindows
    ? argv => runAsWorker(subprocess, argv, cwd, lifetime, { ...stringEnvironment(), PATH: path })
    : argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, lifetime)
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}

/** A minimal HTTP client that setup and the DingTalk transport share; returns the parsed JSON body of a request. */
export type Fetcher = (input: { url: string; method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text: string }>
/** The default fetcher, backed by the global `fetch` that Node 22 provides. */
export const defaultFetcher: Fetcher = async request => {
  const response = await fetch(request.url, { method: request.method, headers: request.headers, ...request.body ? { body: request.body } : {} })
  return { status: response.status, text: await response.text() }
}
const DingtalkToken = z.object({ accessToken: z.string().min(1) })
const DingtalkRobot = z.object({ name: z.string().default(''), robotCode: z.string().default('') })
const DINGTALK_API = 'https://oapi.dingtalk.com'
/**
 * Verify the DingTalk app's AppKey and AppSecret by exchanging them for an access token, then read the robot's name and code.
 * The returned credentials are what the Source uses to receive Stream events and to send replies; a failure disables only DingTalk.
 */
export async function resolveDingtalkBot(machine: Machine, dingtalk: unknown, fetcher: Fetcher = defaultFetcher): Promise<DingtalkBot | undefined> {
  const { appKey, appSecret } = DingtalkBotSchema.parse(dingtalk ?? {})
  if (!appKey && !appSecret) return undefined
  if (!appKey) throw new SetupError('dingtalkAppKeyUnset')
  if (!appSecret) throw new SetupError('dingtalkAppSecretUnset')
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('dingtalkCliFailed', { output: reason(error) }) }
  // Newer endpoint: POST https://api.dingtalk.com/v1.0/oauth2/accessToken with { appKey, appSecret }.
  const token = await fetcher({ url: 'https://api.dingtalk.com/v1.0/oauth2/accessToken', method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appKey, appSecret }) }).catch(fail)
  const parsedToken = parsed(DingtalkToken, token.text)
  if (!parsedToken) return fail(new SetupError('dingtalkCliFailed', { output: `accessToken: ${status(token.status)}` }))
  // A working token proves the credentials; the robot name/code is a best-effort display fact, so its failure must not block setup
  // (the legacy robot-info endpoint is not served for every app). Enterprise internal apps use the AppKey as the robot code.
  let name = appKey, robotCode = appKey
  try {
    const info = await fetcher({ url: `${DINGTALK_API}/topapi/robot/info?access_token=${encodeURIComponent(parsedToken.accessToken)}`, method: 'GET' })
    const value = JSON.parse(info.text) as { errcode?: number; result?: unknown }
    const robot = (value.errcode ?? 0) === 0 ? DingtalkRobot.safeParse(value.result ?? {}) : undefined
    if (robot?.success) { if (robot.data.name) name = robot.data.name; if (robot.data.robotCode) robotCode = robot.data.robotCode }
  } catch { /* Keep the AppKey fallbacks; the token already validated the app. */ }
  return { appKey, appSecret, robotCode, name }
}
const status = (code: number): string => `HTTP ${code}`
