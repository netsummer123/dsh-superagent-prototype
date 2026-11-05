/** GitLab source kind: configuration, per-project polling loops, policy, and the Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { GitlabAccountSchema } from '../deployment.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { claimMergeRequest, observeMergeRequest, pullNumberOf, readMergeRequest } from './gitlab-pull.ts'
import { ciCounts, ciFact, ciFailures, ciSummary, gitlabThreadContext, readPipeline } from './gitlab-read.ts'
import { branchCiTrigger, gitlabPage, gitlabRef, IssueSchema, issueTrigger, MergeRequestSchema, mergeRequestTrigger, mrCiTrigger, NoteSchema,
  noteTrigger, projectSlug, SOURCE, type GitlabIssue, type GitlabMergeRequest } from './gitlab-trigger.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'
import { validItems, type Tally } from '../infra/commands.ts'
import type { Localized, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export { SOURCE } from './gitlab-trigger.ts'
export { gitlabRef, mergeRequestTrigger, noteTrigger, projectSlug, gitlabPage } from './gitlab-trigger.ts'
export { claimMergeRequest, mergeRequestEndNotices, observeMergeRequest, readMergeRequest } from './gitlab-pull.ts'

/** One project the Source watches, with whether it receives every note or only mentions. */
const ProjectRow = z.object({ path: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+$/, 'group/project'), name: z.string().trim().max(80).optional(),
  listen: z.enum(['mentions', 'all']).default('mentions') }).strict()
export const GitlabConfigSchema = GitlabAccountSchema.extend({
  projects: z.array(ProjectRow).refine(rows => new Set(rows.map(row => row.path.toLowerCase())).size === rows.length, 'Duplicate project paths').default([]),
  observeIssues: z.boolean().default(false), observeMergeRequests: z.boolean().default(false), observeComments: z.boolean().default(false), observeCi: z.boolean().default(false),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  readPageSize: z.number().int().min(1).max(100).default(20),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
/** The receiving row a Trigger falls in: the project's slug, or `ci` for a pipeline with no sender. */
const scopeOf = (meta: Record<string, unknown>): string | undefined => meta.ci === true ? 'ci' : typeof meta.slug === 'string' ? meta.slug : undefined
const OBSERVED: Readonly<Record<'issues' | 'pulls' | 'comments', keyof GitlabConfig>> = { issues: 'observeIssues', pulls: 'observeMergeRequests', comments: 'observeComments' }
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '接收下列 GitLab 项目发给智能体账号的 Issue、合并请求、评论与流水线，并轮询已订阅的讨论。', en: 'Receives Issues, merge requests, notes and pipelines addressed to the agent on these GitLab projects, and polls subscribed discussions.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'host', type: 'text', label: { zh: 'GitLab 主机', en: 'GitLab host' }, pattern: '[A-Za-z0-9.\\-]+(:[0-9]+)?',
      hint: { zh: '主机名带端口，例如 git.example.com:9001。保存时用它和 CLI 校验账号与每个项目，然后重启 dsh-superagent。', en: 'Hostname with its port, such as git.example.com:9001. Saving verifies the account and each project with the CLI, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 glab CLI', en: 'Agent glab CLI' },
      hint: { zh: '命令名或绝对路径，指向只登录了这个 GitLab 主机的 glab（可用 GLAB_CONFIG_DIR 隔离）。执行器以 glab 调用它。', en: 'A command name or absolute path of a glab signed in to this GitLab host only (GLAB_CONFIG_DIR isolates it). The Executor calls it as glab.' } },
    { key: 'configDir', type: 'text', advanced: true, label: { zh: 'glab 配置目录', en: 'glab config dir' },
      hint: { zh: '可选。这个来源运行 glab 时使用的 GLAB_CONFIG_DIR；留空则用 CLI 包装脚本自己的配置。', en: 'Optional. The GLAB_CONFIG_DIR this Source runs glab with; empty uses the CLI wrapper\'s own configuration.' } },
    { key: 'projects', type: 'rows', label: { zh: '接收的项目', en: 'Projects' },
      hint: { zh: '每行一个项目，写 group/sub/project。“仅 @”只接收 @ 智能体账号的评论和已有工单的讨论；“全部”也接收没有 @ 的 Issue、合并请求与评论，由策略的接收表决定是否成为候选。', en: 'One project per row as group/sub/project. "@ only" receives notes that mention the agent and Threads that have Tickets; "All" also receives Issues, merge requests and notes that do not mention it, and the Policy\'s admission table decides whether they become candidates.' },
      columns: [
        { key: 'path', type: 'text', label: { zh: '项目', en: 'Project' }, pattern: '(?:[A-Za-z0-9_.\\-]+/)+[A-Za-z0-9_.\\-]+' },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部', en: 'All' } }] },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
      ] },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeMergeRequests', type: 'switch', label: { zh: '接收项目里的新合并请求', en: 'Receive new merge requests' },
      hint: { zh: '打开后，没有 @ 智能体的新合并请求也会收到，由策略的接收表决定是否成为候选。', en: 'New merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收默认分支的流水线', en: 'Receive the default branch pipeline' },
      hint: { zh: '打开后，每个项目默认分支的流水线失败和恢复会收到，由策略的接收表决定是否成为候选。', en: 'A pipeline failure on each project\'s default branch, and its recovery, are received, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 100, label: { zh: '每页消息数', en: 'Messages per page' } },
  ],
  // What the Source observes across each project it receives in full; elsewhere, only what addresses the agent.
  scope: ({ meta }, config) => {
    const slug = scopeOf(meta)
    if (slug === 'ci') return { listened: true, observed: config.observeCi, row: 'ci' }
    const project = config.projects.find(row => projectSlug(row.path) === slug)
    if (!project) return { listened: false, reason: 'project_not_listed' }
    const observed = project.listen === 'all'
    return { listened: true, observed, row: projectSlug(project.path) }
  },
  health: ['gitlab'],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  // A project path, an issue `#12`, a merge request `!12`, or a page URL names the Thread; the caller scopes the search.
  find: query => {
    const page = /^https?:\/\/[^/]+\/([^/]+(?:\/[^/]+)*)\/-\/(issues|merge_requests)\/(\d+)/.exec(query.trim())
    const bare = /^([#!]?)(\d+)$/.exec(query.trim())
    if (page) return { threads: [`${SOURCE}:${projectSlug(page[1]!)}:${page[3]}`], terms: [] }
    if (bare) return { threads: [], terms: [bare[2]!] }
    return { threads: [], terms: [] }
  },
  repliesTo: trigger => typeof trigger.meta.noteId === 'number' ? undefined : undefined,
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9._-]+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id.toLowerCase())).size === users.length, 'Duplicate usernames').default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9._-]+$/), name: z.string().trim().max(100).optional() }).strict()).optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'username', en: 'username' }, pattern: '[A-Za-z0-9._\\-]+' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose notes may become candidates' },
        hint: { zh: '名单里的机器人账号的评论在来源收到时成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。其他机器人的评论不接收。', en: 'A note of a bot account on this list becomes an inferred candidate when the Source receives it; it never makes an explicit request or stops a ticket. Other bots\' notes are not admitted.' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'username', en: 'username' }, pattern: '[A-Za-z0-9._\\-]+' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a note.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (all: boolean) => all ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      return [
        ...(config.projects ?? []).map(row => ({ id: projectSlug(row.path), label: row.name || row.path, note: note(row.listen === 'all'),
          cells: { listedUnaddressed: row.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: row.listen === 'all' } })),
        // A pipeline has no sender, so only the cell of a sender off the list who does not address the agent applies.
        { id: 'ci', label: { zh: '默认分支的流水线', en: 'Default branch pipeline' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: '这个来源的 GitLab 主机（含端口）', en: 'The GitLab host (with its port) of this Source' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '接下工单的项目 group/project；工单不是从 GitLab 来的时为空', en: 'The project that started the ticket, as group/project; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录，除合并外的 GitLab 操作用它', en: 'The agent\'s GitLab account; glab is signed in to it, and use it for every GitLab operation except merging' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱；git 在这里没有身份，按提示词写明的作者提交，未写明时用这个邮箱', en: 'Commit email of the agent\'s account; git has no identity here, so commit as the author the instructions name, or with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '接下工单的 Issue 或合并请求编号；工单不是从 GitLab 来的时为空', en: 'Number of the Issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', description: { zh: '接手工单的合并请求的 head 引用 refs/merge-requests/<编号>/head；不是合并请求时为空', en: 'Head ref refs/merge-requests/<iid>/head of the merge request that started the ticket; empty when it was not a merge request' } },
    ],
    values: ({ deployment, trigger }) => {
      const onGitlab = trigger?.source === SOURCE
      const iid = onGitlab && trigger ? Number(trigger.meta.iid) || 0 : 0
      return { DSH_SUPERAGENT_GITLAB_HOST: deployment.gitlab?.host ?? '',
        DSH_SUPERAGENT_GITLAB_PROJECT: onGitlab && trigger ? String(trigger.meta.project ?? '') : '',
        DSH_SUPERAGENT_GITLAB_ACCOUNT: deployment.gitlab?.login ?? '',
        DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: deployment.gitlab?.commitEmail ?? '',
        DSH_SUPERAGENT_GITLAB_IID: iid ? String(iid) : '',
        DSH_SUPERAGENT_GITLAB_MR_HEAD: iid && trigger?.meta.kind === 'mr' ? `refs/merge-requests/${iid}/head` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab
    ? { host: { zh: `当前账号 @${deployment.gitlab.login}，${deployment.gitlab.projects.length} 个项目`, en: `Current account @${deployment.gitlab.login}, ${deployment.gitlab.projects.length} projects` } }
    : {},
}

export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop becomes the Source's health.
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single interruption stays quiet. */
export const pollFailure = (failures: number, threshold: number, error: unknown): Health | undefined =>
  failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  // Setup resolves the GitLab account and projects and restarts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config && ctx.deployment.gitlab) await pollRound(ctx, signal)
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 3, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause(Math.max(60, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}

interface Round { started: string; signal?: AbortSignal | undefined; failures: string[]; tally: Tally }
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)

/** One polling round: per project, new Issues and merge requests, then merged or closed MRs of open tickets, then subscribed Threads. */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const round: Round = { started: new Date().toISOString(), signal, failures: [], tally: { skipped: 0 } }
  const config = ctx.config<GitlabConfig>(SOURCE)
  const gitlab = ctx.deployment.gitlab
  if (!config || !gitlab) return
  for (const project of gitlab.projects) {
    if (stopped(ctx, round)) break
    try { await readProjectStream(ctx, round, project.path, config) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${project.path}: ${String(error)}`) }
    if (stopped(ctx, round)) break
    try { await pollProjectCi(ctx, round, project.path, project.defaultBranch, config) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${project.path} CI: ${String(error)}`) }
  }
  await pollTicketMergeRequests(ctx, signal, round)
  await pollThreads(ctx, signal, round)
  if (signal?.aborted) return
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  ctx.report('gitlab', { state: 'ready', detail: `${gitlab.projects.length} projects; next poll ≥ ${config.pollSeconds}s${round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''}`, at: round.started })
}
/**
 * Reads one project's Issue and merge-request streams since their cursor (oldest first), stepping each cursor to five seconds
 * before the newest item so late writes are not missed and relying on stable Trigger ids to deduplicate.
 */
async function readProjectStream(ctx: SourceContext, round: Round, project: string, config: GitlabConfig): Promise<void> {
  const slug = projectSlug(project)
  const types: { stream: 'issues' | 'pulls'; observed: boolean; path: string }[] = [
    { stream: 'issues', observed: config.observeIssues, path: 'issues?scope=all&state=all&order_by=updated_at&sort=asc' },
    { stream: 'pulls', observed: config.observeMergeRequests, path: 'merge_requests?scope=all&state=all&order_by=updated_at&sort=asc' },
  ]
  for (const type of types) {
    if (stopped(ctx, round)) return
    const key = KV.gitlab.stream(slug, type.stream)
    if (!type.observed) { ctx.state.set(key, undefined); continue }
    const stored = ctx.state.get(key)
    const started = stored?.started?.[type.stream] ?? round.started
    const horizon = new Date(Math.max(Date.parse(stored?.since ?? round.started), Date.parse(round.started) - POLL_HORIZON_MS)).toISOString()
    const since = stored?.since && Date.parse(stored.since) > Date.parse(horizon) ? stored.since : new Date(horizon).toISOString()
    const separator = type.path.includes('?') ? '&' : '?'
    const items = await ctx.commands.withSignal(round.signal).gitlabPages(project, `${type.path}${separator}updated_after=${encodeURIComponent(since)}`)
    const agent = ctx.deployment.gitlab!.login
    const host = ctx.deployment.gitlab!.host
    let newest = Date.parse(since)
    for (const raw of items) {
      if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
      const at = (raw as { updated_at?: unknown }).updated_at
      if (typeof at === 'string') newest = Math.max(newest, Date.parse(at))
      const created = (raw as { created_at?: unknown }).created_at
      if (typeof created !== 'string' || Date.parse(created) < Date.parse(started)) continue
      if ((raw as { author?: { username?: unknown } }).author?.username === agent) continue
      if (type.stream === 'issues') {
        const issue = IssueSchema.safeParse(raw)
        if (issue.success) await ctx.receive(issueTrigger(issue.data as GitlabIssue, project, host, agent))
      } else {
        const mr = MergeRequestSchema.safeParse(raw)
        if (mr.success) await ctx.receive(mergeRequestTrigger(mr.data as GitlabMergeRequest, project, host, agent))
      }
    }
    ctx.state.set(key, { since: newest > Date.parse(since) ? cursorAt(new Date(newest).toISOString()) : since, started: { [type.stream]: started } })
  }
}
/** Emits a default-branch pipeline Trigger only when the set of failing jobs changes after an initial baseline. */
async function pollProjectCi(ctx: SourceContext, round: Round, project: string, branch: string, config: GitlabConfig): Promise<void> {
  const slug = projectSlug(project)
  const key = KV.gitlab.branchCi(slug)
  const previous = ctx.state.get(key)
  if (!config.observeCi) { if (previous) ctx.state.set(key, { revision: previous.revision }); return }
  const commands = ctx.commands.withSignal(round.signal)
  const branches = await commands.gitlabApi<unknown>(project, `repository/branches/${encodeURIComponent(branch)}`)
  const sha = (branches as { commit?: { id?: unknown } }).commit?.id
  if (typeof sha !== 'string') return
  const snapshot = await readPipeline(commands, project, sha, round.tally)
  const known = previous?.branch === branch ? previous.failures : undefined
  const failures = ciFailures(snapshot)
  const counts = ciCounts(snapshot)
  const now = failures.length || !counts.running ? failures : known ?? []
  let revision = previous?.revision ?? 0
  if (known && JSON.stringify(now) !== JSON.stringify(known)) {
    revision += 1
    const summary = ciSummary(snapshot, branch, `gitlab/${slug}/commits/${sha}/pipeline`)
    const url = gitlabPage(ctx.deployment.gitlab!.host, project, 0, 'issue').replace(/\/0$/, `/-/commit/${sha}`)
    await ctx.receive(branchCiTrigger(project, branch, sha, revision, summary, url))
    ctx.threads.describe(`gitlab:ci:${slug}:${branch}`, { label: `CI on ${branch}`, facts: { ci: ciFact(counts) } })
  }
  ctx.state.set(key, { branch, failures: now, revision })
}
/** Reconciles the merge requests of open tickets: binds a ticket's MR and reports merged or closed ones to the core. */
async function pollTicketMergeRequests(ctx: SourceContext, signal: AbortSignal | undefined, round: Round): Promise<void> {
  const seen = new Set<string>()
  for (const ticket of ctx.tickets.open()) {
    for (const follow of ticket.follows ?? []) {
      const number = pullNumberOf(follow.thread)
      if (!number || number.slug === undefined) continue
      const project = number.slug.replaceAll('~', '/')
      const projectCfg = ctx.deployment.gitlab?.projects.find(item => item.path === project)
      if (!projectCfg || seen.has(follow.thread)) continue
      seen.add(follow.thread)
      try {
        const mr = await readMergeRequest(ctx, project, number.iid, signal)
        const ended = await observeMergeRequest(ctx, project, mr)
        if (!ended) claimMergeRequest(ctx, ticket.id, project, mr)
      } catch (error) { if (!signal?.aborted) round.failures.push(`${follow.thread}: ${String(error)}`) }
    }
  }
}
/** Polls subscribed GitLab threads within the horizon so notes missed between rounds become triggers. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round?: Round): Promise<void> {
  await pollEach(ctx, SOURCE, () => !!signal?.aborted, thread => pollThread(ctx, thread, signal, round),
    thread => {
      const key = thread.key.slice(SOURCE.length + 1)
      const at = key.lastIndexOf(':')
      return at < 0 || pullNumberOf(thread.key) === undefined
    })
}
async function pollThread(ctx: SourceContext, thread: { key: string; createdAt: string; meta: Record<string, unknown> }, signal?: AbortSignal, round?: Round): Promise<void> {
  const number = pullNumberOf(thread.key)
  if (!number) throw new Error('Subscribed thread has no merge request')
  const project = number.slug.replaceAll('~', '/')
  const config = ctx.config<GitlabConfig>(SOURCE)
  const agent = ctx.deployment.gitlab!.login
  const host = ctx.deployment.gitlab!.host
  const commands = ctx.commands.withSignal(signal)
  const checkpoint = KV.gitlab.seen(thread.key)
  const known = new Set(ctx.state.get(checkpoint) ?? [])
  const initialized = ctx.state.get(KV.gitlab.initialized(thread.key))
  const base = `merge_requests/${number.iid}/notes?sort=asc&order_by=created_at&per_page=${Math.min(config?.readPageSize ?? 20, 100)}`
  const items = await commands.gitlabPages(project, base)
  const notes = validItems(NoteSchema, items, round?.tally)
  for (const note of notes) {
    if (known.has(String(note.id))) continue
    const trigger = noteTrigger(note, { project, slug: number.slug, iid: number.iid, kind: 'mr' }, agent)
    if (!trigger) { known.add(String(note.id)); continue }
    if (!initialized && Date.parse(trigger.at) < Date.parse(thread.createdAt)) { known.add(String(note.id)); continue }
    await ctx.receive(trigger)
    known.add(String(note.id))
  }
  ctx.state.set(checkpoint, [...known])
  ctx.state.set(KV.gitlab.initialized(thread.key), true)
  void host
}
