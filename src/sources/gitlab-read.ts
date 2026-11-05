/** Read-only GitLab conversation and pipeline inspection for assessments and workers, and the `gitlab/` context reader. */
import { z } from 'zod'
import type { ThreadFact, Trigger } from '../core/index.ts'
import { validItems, type Commands } from '../infra/commands.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'
import { gitlabRef, isHumanUser, mergeRequestTrigger, NoteSchema, type GitlabMergeRequest, type GitlabNote, type GitlabRef } from './gitlab-trigger.ts'

/** A pipeline job's status counted as failing or still running. */
const FAILING = new Set(['failed', 'canceled'])
const RUNNING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'manual', 'scheduled'])
const JobSchema = z.looseObject({ name: z.string(), status: z.string() })
export interface GitlabCiSnapshot { sha: string; jobs: { name: string; status: string }[] }
export function ciCounts(snapshot: GitlabCiSnapshot): { failed: number; running: number } {
  const jobs = snapshot.jobs ?? []
  return { failed: jobs.filter(job => FAILING.has(job.status)).length, running: jobs.filter(job => RUNNING.has(job.status)).length }
}
export function ciFailures(snapshot: GitlabCiSnapshot): string[] {
  return snapshot.jobs.filter(job => FAILING.has(job.status)).map(job => job.name).sort()
}
export function ciFact(counts: { failed: number; running: number }): ThreadFact {
  if (counts.failed) return { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(counts.failed), problem: true }
  if (counts.running) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: String(counts.running) }
  return { label: 'CI', value: { zh: '通过', en: 'passed' } }
}
export function ciSummary(snapshot: GitlabCiSnapshot, where: string, read: string): string {
  const results = snapshot.jobs.map(job => ({ name: job.name, failed: FAILING.has(job.status), running: RUNNING.has(job.status) }))
  const failed = results.filter(item => item.failed).map(item => item.name)
  const running = results.filter(item => item.running).map(item => item.name)
  const names = (list: string[]) => list.slice(0, 5).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '')
  const at = `on ${where} at ${snapshot.sha.slice(0, 7)}`
  const still = running.length ? `; ${running.length} still running` : ''
  const line = failed.length ? `CI failed ${failed.length}/${results.length} ${at}: ${names(failed)}${still}`
    : running.length ? `CI running ${running.length}/${results.length} ${at}: ${names(running)}`
      : `CI passed ${results.length}/${results.length} ${at}`
  return `${line}\nRead ${read} for every job.`
}

/** Reads a pipeline's jobs for a commit or pipeline id, without emitting a trigger. */
export async function readPipeline(commands: Commands, project: string, sha: string, tally?: { skipped: number }): Promise<GitlabCiSnapshot> {
  const pages = await commands.gitlabPages(project, 'pipelines', 100)
  const latest = pages.find(item => item !== null && typeof item === 'object' && (item as { sha?: unknown }).sha === sha) as { id: number } | undefined
  if (!latest) return { sha, jobs: [] }
  const jobs = await commands.gitlabPages(project, `pipelines/${latest.id}/jobs`, 100)
  return { sha, jobs: validItems(JobSchema, jobs, tally) }
}

/** Formats a note as a model-facing ContextMessage, marking bots and system notes because their words never authorize work. */
export function noteView(note: GitlabNote, text = note.body ?? ''): ContextMessage {
  return { id: String(note.id), from: note.author.username, at: note.updated_at ?? note.created_at ?? '', text,
    ...!isHumanUser(note.author) ? { bot: true } : {},
    ...(note.position ? { path: note.position.new_path ?? note.position.old_path ?? undefined,
      ...(note.position.new_line ?? note.position.old_line) != null ? { line: note.position.new_line ?? note.position.old_line ?? undefined } : {} } : {}),
  }
}
/** Reads one page of an issue's or merge request's conversation notes, oldest first. */
export async function readNotes(commands: Commands, ref: GitlabRef, page: number, perPage: number): Promise<{ messages: ContextMessage[]; more: boolean }> {
  const base = ref.kind === 'mr' ? `merge_requests/${ref.iid}` : `issues/${ref.iid}`
  const order = `notes?sort=asc&order_by=created_at&page=${page}&per_page=${perPage}`
  const listed = await commands.gitlabApi<unknown>(ref.project, `${base}/${order}`)
  const items = Array.isArray(listed) ? listed : []
  const notes = validItems(NoteSchema, items)
  const messages = notes.filter(note => !note.system).map(note => noteView(note))
  return { messages, more: items.length >= perPage }
}
/** Reads the merge request behind an address, so its review threads and pipeline can be read. */
export const readMergeRequest = async (commands: Commands, ref: GitlabRef): Promise<GitlabMergeRequest> =>
  commands.gitlabApi<GitlabMergeRequest>(ref.project, `merge_requests/${ref.iid}`)

/** Builds the merge-request trigger for an MR read back from GitLab, used when polling a subscribed thread finds a new MR state. */
export const readMergeRequestTrigger = (mr: GitlabMergeRequest, project: string, host: string, agent: string): Trigger =>
  mergeRequestTrigger(mr, project, host, agent)

/**
 * The `gitlab/` context reader: a page of a Trigger's issue or merge-request notes, keyed by the section the caller asked for
 * (`notes` or a page number). Reads are context only and never authorize work.
 */
export async function gitlabRead(commands: Commands, ref: GitlabRef, section: string, pageSize: number): Promise<ContextPart> {
  const page = /^\d+$/.test(section) ? Number(section) : 1
  const { messages, more } = await readNotes(commands, ref, page, pageSize)
  return { messages, next: more ? String(page + 1) : undefined, body: { status: 'available', messages } }
}
export const gitlabThreadContext: ThreadContext<{ readPageSize: number }> = {
  messageId: trigger => String(trigger.meta.noteId ?? ''),
  read: async (commands, trigger, _part, cursor, config) => {
    const ref = gitlabRef(trigger)
    if (!ref) throw new Error('A GitLab source trigger is required')
    const page = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 1
    const { messages, more } = await readNotes(commands, ref, page, config.readPageSize)
    return { messages, ...(more ? { next: String(page + 1) } : {}), body: { status: 'available', messages } }
  },
}
