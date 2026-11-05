/** Merge-request binding, lifecycle observation, and terminal IM-notice helpers for GitLab. */
import { key, liveTicket, type Follow, type OutboundMessage, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { SourceContext } from './host.ts'
import { gitlabPage, MergeRequestSchema, projectSlug, type GitlabMergeRequest } from './gitlab-trigger.ts'

const PREFIX = 'gitlab:'
/** The merge-request number a ticket follows, from a Thread key `gitlab:<slug>:<iid>`; undefined for other threads. */
export const pullNumberOf = (thread: string): { slug: string; iid: number } | undefined => {
  if (!thread.startsWith(PREFIX)) return undefined
  const rest = thread.slice(PREFIX.length)
  const at = rest.lastIndexOf(':')
  if (at < 0) return undefined
  const iid = Number(rest.slice(at + 1))
  return Number.isInteger(iid) && iid > 0 ? { slug: rest.slice(0, at), iid } : undefined
}
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): { slug: string; iid: number }[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => { const number = pullNumberOf(item.thread); return number ? [number] : [] })
/** True when the MR was opened by the agent account from a branch whose last segment is the ticket's short name. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
/** True when the merge request's author is the agent account and it targets a configured project (not a fork). */
export const agentMergeRequest = (mr: GitlabMergeRequest, project: string, deployment: Pick<Deployment, 'gitlab'>): boolean =>
  !!deployment.gitlab && mr.author.username === deployment.gitlab.login && project === deployment.gitlab.projects.find(item => item.id === mr.source_project_id)?.path
/** Reads one merge request of a project. */
export const readMergeRequest = async (ctx: SourceContext, project: string, iid: number, signal?: AbortSignal): Promise<GitlabMergeRequest> =>
  MergeRequestSchema.parse(await ctx.commands.withSignal(signal).gitlabApi(project, `merge_requests/${iid}`))
/**
 * Bind an open merge request to a ticket when it is the ticket's origin MR, or an agent MR on the ticket's branch. Returns an
 * error message when binding is rejected, or undefined when bound or when the MR is not open.
 */
export function claimMergeRequest(ctx: SourceContext, ticketId: string, project: string, mr: GitlabMergeRequest): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its merge request was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === 'gitlab' && source.meta.kind === 'mr' && source.meta.iid === mr.iid && source.meta.project === project
  const opened = agentMergeRequest(mr, project, ctx.deployment) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    const login = ctx.deployment.gitlab?.login ?? 'the agent'
    return `MR does not belong to this ticket: use the source MR or an MR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME`
  }
  const owner = ctx.tickets.open().find(item => pullsOf(item, true).some(number => number.slug === projectSlug(project) && number.iid === mr.iid))
  if (owner && owner.id !== ticketId) return 'MR already belongs to another active ticket'
  const thread = `${PREFIX}${projectSlug(project)}:${mr.iid}`
  const follow = ticket.follows?.find(item => item.thread === thread)
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, project, mr, opened)
  return undefined
}
/** Reconcile a polled MR's open/merged/closed state with any bound or branch-matching ticket; returns whether it ended. */
export async function observeMergeRequest(ctx: SourceContext, project: string, mr: GitlabMergeRequest): Promise<boolean> {
  const ended = mr.state === 'closed' || mr.state === 'merged' || !!mr.merged_at
  if (ended) closeMergeRequest(ctx, project, mr)
  else {
    const candidates = agentMergeRequest(mr, project, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    const thread = `${PREFIX}${projectSlug(project)}:${mr.iid}`
    const reopened = ticket?.follows?.some(item => item.thread === thread && item.closed)
    if (ticket && (reopened || pullsOf(ticket, true).every(number => number.slug === projectSlug(project) && number.iid === mr.iid))) claimMergeRequest(ctx, ticket.id, project, mr)
  }
  ctx.threads.describe(`${PREFIX}${projectSlug(project)}:${mr.iid}`, {})
  return ended
}
function bind(ctx: SourceContext, ticketId: string, project: string, mr: GitlabMergeRequest, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: 'gitlab', id: `${projectSlug(project)}:${mr.iid}` }, own)
    ctx.threads.patch(`${PREFIX}${projectSlug(project)}:${mr.iid}`, { project, iid: mr.iid, kind: 'mr', url: mr.web_url, mrAuthor: mr.author.username })
  })
}
/** Reports a merged or closed MR once to the open tickets that follow it; the ticket's end is the core's decision. */
function closeMergeRequest(ctx: SourceContext, project: string, mr: GitlabMergeRequest): void {
  const slug = projectSlug(project)
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true).some(number => number.slug === slug && number.iid === mr.iid))) return
  const at = mr.merged_at ?? mr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: 'gitlab', id: `${slug}:${mr.iid}` }, mr.state === 'merged' ? 'merged' : 'closed', at)
}
/**
 * Builds the IM notices for a ticket that ended with its merge request. Language follows the request text: Chinese when it has
 * Han characters and no kana, otherwise English. GitLab's own timeline shows the merge, so GitLab channels are skipped.
 */
export function mergeRequestEndNotices(ticket: Ticket, request: string, host: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && pullNumberOf(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const { slug, iid } = pullNumberOf(follow.thread)!
  const project = slug.replaceAll('~', '/')
  const url = gitlabPage(host, project, iid, 'mr')
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[MR !${iid}](${url}) 已合并。` : `[MR !${iid}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${iid}](${url}) has merged.` : `[MR !${iid}](${url}) was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== 'gitlab').map(channel => ({
    id: key('mr-terminal', String(iid), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
