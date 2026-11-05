/** Normalizes GitLab issues, merge requests, notes, discussions, and pipeline changes into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/**
 * A project's stable, reversible key for Thread ids and Channel addresses: its path with each `/` written as `~`, because a
 * Thread key joins its parts with `:` and a project path itself may contain `:` in a namespace name.
 */
export const projectSlug = (project: string): string => project.replaceAll('/', '~')
/** The project path a slug was built from. */
export const slugProject = (slug: string): string => slug.replaceAll('~', '/')
/** What a Channel address and Threads identify: the project and the issue or merge request number.
 * `kind` says which conversation it is, because GitLab numbers issues and merge requests separately. */
export interface GitlabRef { project: string; slug: string; iid: number; kind: 'issue' | 'mr' }
/** A reply address: where a note goes, and the discussion thread when the conversation is a merge request thread. */
export const gitlabChannel = (ref: GitlabRef, options: { url?: string; discussionId?: string } = {}): ChannelRef =>
  ({ source: SOURCE, thread: `${SOURCE}:${ref.slug}:${ref.iid}`,
    address: { project: ref.project, slug: ref.slug, iid: String(ref.iid), kind: ref.kind,
      ...(options.discussionId ? { discussionId: options.discussionId } : {}), ...(options.url ? { url: options.url } : {}) } })
/** The page URL of an issue or merge request on the configured host. */
export const gitlabPage = (host: string, project: string, iid: number, kind: 'issue' | 'mr'): string =>
  `https://${host}/${project}/-/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
/** A GitLab user as the API returns it; `bot` marks a bot account, which never authorizes work on its own. */
export const UserSchema = z.looseObject({ username: z.string(), name: z.string().optional(), bot: z.boolean().nullish() })
export type GitlabUser = z.infer<typeof UserSchema>
/**
 * A note (comment) as GitLab returns it. A discussion note carries its `discussion_id` and `position`; a system note records a
 * state change such as closing the issue and carries no one who asked for work.
 */
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: UserSchema, system: z.boolean().optional(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), noteable_iid: z.number().nullish(),
  discussion_id: z.string().nullish(), web_url: z.string().nullish(),
  position: z.looseObject({ new_path: z.string().nullish(), old_path: z.string().nullish(), new_line: z.number().nullish(), old_line: z.number().nullish() }).nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>
/** An issue or merge request; `iid` is the per-project number a person sees, and `id` the global one. */
export const IssueSchema = z.looseObject({
  iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(),
  author: UserSchema, created_at: z.string(), updated_at: z.string().nullish(), web_url: z.string(),
  labels: z.array(z.union([z.string(), z.looseObject({ name: z.string() })])).optional(),
})
export type GitlabIssue = z.infer<typeof IssueSchema>
/** A merge request extends an issue's shape with its branches, head commit, and merge state. */
export const MergeRequestSchema = IssueSchema.extend({
  source_branch: z.string(), target_branch: z.string(), sha: z.string().nullish(), merged_at: z.string().nullish(),
  closed_at: z.string().nullish(), source_project_id: z.number().nullish(), state: z.string(),
  detailed_merge_status: z.string().nullish(),
})
export type GitlabMergeRequest = z.infer<typeof MergeRequestSchema>
/** True when GitLab reports the account as a person rather than a bot (project and group access tokens run as bot users). */
export const isHumanUser = (user: { username: string; bot?: boolean | null }): boolean => user.bot !== true
export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@.])@${escapeRegExp(username)}(?![a-zA-Z0-9_.-])`).test(text)
const author = (user: GitlabUser, agent: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: isHumanUser(user) && user.username !== agent })
/** Formats an inline note's file and line, which GitLab reports in `position`, ahead of its body. */
function notePlace(note: GitlabNote): string {
  const position = note.position
  if (!position) return ''
  const path = position.new_path ?? position.old_path ?? ''
  const line = position.new_line ?? position.old_line
  return path && line != null ? `${path}:${line}` : path
}
/**
 * Builds a Trigger for a note. A system note (a state change) produces none, because no one asked for work; the caller filters
 * the agent's own notes out too. The version keeps an edited note a distinct Trigger id.
 */
export function noteTrigger(note: GitlabNote, ref: GitlabRef, agent: string): Trigger | undefined {
  if (note.system) return undefined
  const at = note.updated_at ?? note.created_at ?? new Date().toISOString()
  const version = note.updated_at ?? note.created_at ?? ''
  const place = ref.kind === 'mr' && note.position ? notePlace(note) : ''
  return { id: key('gitlab-note', `${ref.project}!${ref.kind}${ref.iid}`, String(note.id), version), source: SOURCE,
    threads: [{ source: SOURCE, id: `${ref.slug}:${ref.iid}` }], ...author(note.author, agent), at,
    text: [place, note.body ?? ''].filter(Boolean).join('\n\n'),
    ...(mentions(note.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref, { ...(note.discussion_id ? { discussionId: note.discussion_id } : {}), ...(note.web_url ? { url: note.web_url } : {}) }),
    ...(note.web_url ? { url: note.web_url } : {}),
    meta: { project: ref.project, slug: ref.slug, iid: ref.iid, kind: ref.kind, noteId: note.id,
      ...(note.discussion_id ? { discussionId: note.discussion_id } : {}),
      ...(place ? { path: note.position?.new_path ?? note.position?.old_path ?? null, line: note.position?.new_line ?? note.position?.old_line ?? null } : {}) } }
}
/** Builds the Trigger for a newly described issue: its title and description, addressed when it mentions the agent. */
export function issueTrigger(issue: GitlabIssue, project: string, host: string, agent: string): Trigger {
  const ref: GitlabRef = { project, slug: projectSlug(project), iid: issue.iid, kind: 'issue' }
  const body = issue.description ?? ''
  const url = issue.web_url || gitlabPage(host, project, issue.iid, 'issue')
  return { id: key('gitlab-issue', `${project}#${issue.iid}`), source: SOURCE, threads: [{ source: SOURCE, id: `${ref.slug}:${issue.iid}` }],
    ...author(issue.author, agent), at: issue.created_at, text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}), channel: gitlabChannel(ref, { url }), url,
    meta: { project, slug: ref.slug, iid: issue.iid, kind: 'issue' } }
}
/** Builds the Trigger for a newly opened merge request; its threads and reply target are the MR conversation. */
export function mergeRequestTrigger(mr: GitlabMergeRequest, project: string, host: string, agent: string): Trigger {
  const ref: GitlabRef = { project, slug: projectSlug(project), iid: mr.iid, kind: 'mr' }
  const body = mr.description ?? ''
  const url = mr.web_url || gitlabPage(host, project, mr.iid, 'mr')
  return { id: key('gitlab-mr', `${project}!${mr.iid}`), source: SOURCE, threads: [{ source: SOURCE, id: `${ref.slug}:${mr.iid}` }],
    ...author(mr.author, agent), at: mr.created_at, text: `${mr.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}), channel: gitlabChannel(ref, { url }), url,
    meta: { project, slug: ref.slug, iid: mr.iid, kind: 'mr', mrAuthor: mr.author.username, sourceBranch: mr.source_branch, targetBranch: mr.target_branch } }
}
/** Builds a Trigger for a default-branch pipeline transition; the default branch has no one to reply to, so it has no channel. */
export function branchCiTrigger(project: string, branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('gitlab-ci', `${project}:branch:${branch}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: `ci:${projectSlug(project)}:${branch}` }], actor: { source: SOURCE, id: '' }, human: false,
    at: new Date().toISOString(), text: summary, url, meta: { project, slug: projectSlug(project), ci: true, branch, sha, revision } }
}
/** Builds a Trigger for a merge request's pipeline transition, addressed to the MR's author. */
export function mrCiTrigger(mr: { iid: number; web_url: string; author: { username: string } }, project: string, revision: number, summary: string): Trigger {
  const ref: GitlabRef = { project, slug: projectSlug(project), iid: mr.iid, kind: 'mr' }
  return { id: key('gitlab-ci', `${project}!${mr.iid}`, String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: `${ref.slug}:${mr.iid}` }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(), text: summary,
    channel: gitlabChannel(ref, { url: mr.web_url }), url: mr.web_url,
    meta: { project, slug: ref.slug, iid: mr.iid, kind: 'mr', mrAuthor: mr.author.username, ci: true, revision } }
}
/** A retained reference to a Trigger's note, threading its context reads. */
export interface GitlabRefAnchor extends GitlabRef { triggerId: string; noteId?: number; discussionId?: string }
export function gitlabRef(trigger: Trigger): GitlabRefAnchor | undefined {
  const meta = trigger.meta as { project?: string; slug?: string; iid?: number; kind?: 'issue' | 'mr'; discussionId?: string; noteId?: number }
  if (trigger.source !== SOURCE || !meta.project || !meta.slug || typeof meta.iid !== 'number' || !meta.kind) return undefined
  return { triggerId: trigger.id, project: meta.project, slug: meta.slug, iid: meta.iid, kind: meta.kind,
    ...(typeof meta.noteId === 'number' ? { noteId: meta.noteId } : {}), ...(meta.discussionId ? { discussionId: meta.discussionId } : {}) }
}
