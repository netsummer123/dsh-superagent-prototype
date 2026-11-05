/** GitLab outbound channel: posts a note to the issue or merge request conversation, or replies inside a discussion thread. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { gitlabPage } from './gitlab-trigger.ts'

/** True when GitLab permanently refuses delivery: the issue, MR, or project is gone (404) or the account may not note (403). */
const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 404 || error.code === 403 || /not found|forbidden/i.test(error.message))
/** The hidden marker that makes a send idempotent, because GitLab offers no idempotency key: a retry finds its own note. */
export const noteMarker = (id: string): string => `<!-- dsh-superagent:${id} -->`
/**
 * Posts one note, at most once per `message.id`. When the address names a discussion the note joins that thread; otherwise it
 * starts a new note on the issue or merge request. Idempotency is the marker appended to the body, searched before writing.
 */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { project, iid, kind, discussionId } = message.channel.address
  const number = Number(iid)
  if (!project || !number || (kind !== 'issue' && kind !== 'mr')) throw new Error('Missing GitLab reply target')
  const text = checkedImText(message.text)
  const base = kind === 'mr' ? `merge_requests/${number}` : `issues/${number}`
  const marker = noteMarker(message.id)
  try {
    // A retry may arrive after GitLab already stored the note; look for this send's marker first.
    const existing = await host.commands.gitlabPages(project, `${base}/notes`)
    if (existing.some(item => item !== null && typeof item === 'object' && String((item as { body?: unknown }).body ?? '').includes(marker))) return 'sent'
    const path = discussionId ? `${base}/discussions/${encodeURIComponent(discussionId)}/notes` : `${base}/notes`
    await host.commands.gitlabApi(project, path, { method: 'POST', body: { body: `${text}\n\n${marker}` } })
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** A link to the issue or merge request the address names. */
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const host = links.gitlab?.host ?? ''
  const project = address.project ?? ''
  const number = Number(address.iid)
  const kind = address.kind === 'mr' ? 'mr' : 'issue'
  const url = address.url ?? (host && project && number ? gitlabPage(host, project, number, kind) : '')
  return { url, label: kind === 'mr' ? { zh: `GitLab !${number}`, en: `GitLab !${number}` } : { zh: `GitLab #${number}`, en: `GitLab #${number}` } }
}
