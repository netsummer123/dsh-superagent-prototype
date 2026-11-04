/**
 * Trigger-scoped DingTalk context reader. DingTalk offers no bot-visible group history, so a read returns the bounded window
 * the installed history reader can produce for the conversation; when none is installed the read reports `unavailable` and the
 * assessment falls back to the Trigger text alone. Retrieved messages never enter intake and never authorize work.
 */
import { validItems } from '../infra/commands.ts'
import type { Commands } from '../infra/commands.ts'
import type { Trigger } from '../core/index.ts'
import { readHistory } from './dingtalk-loops.ts'
import { dingtalkRef, dingtalkTime, HistoryMessageSchema, type HistoryMessage } from './dingtalk-trigger.ts'
import type { ContextMessage, ContextPart, ContextPartName, ThreadContext } from './kind.ts'

/** Maps a DingTalk message read from the history API to the compact context shape the assessment reads. */
export function dingtalkView(message: HistoryMessage): ContextMessage {
  let at: string
  try { at = dingtalkTime(message.createAt) } catch { at = String(message.createAt) }
  return { id: message.msgId, from: message.senderStaffId ?? message.senderId, at, text: message.content ?? '',
    ...message.parentId ? { reply_to: message.parentId } : {} }
}
/**
 * Reads the Trigger's conversation as one bounded page. `part` selects the focus: `thread` reads the conversation window,
 * while `root` and `parent` read the single message the Trigger threads under or answers, when the history holds it.
 */
export async function dingtalkRead(commands: Commands, trigger: Trigger, part: ContextPartName, pageSize: number):
  Promise<ContextPart> {
  const ref = dingtalkRef(trigger)
  if (!ref) throw new Error('A DingTalk source trigger is required')
  const items = await readHistory(commands, { conversationId: ref.conversationId, msgId: ref.msgId,
    since: ref.at ?? new Date(0).toISOString(), until: new Date().toISOString(), maxResults: pageSize })
  if (!items.length) return { messages: [], body: { status: 'unavailable', messages: [] }, status: 'unavailable' }
  const messages = validItems(HistoryMessageSchema, items).map(message => dingtalkView(message as HistoryMessage))
  if (part === 'root' || part === 'parent') {
    const target = part === 'root' ? (trigger.meta.rootId as string | undefined) : (trigger.meta.parentId as string | undefined)
    const message = target ? messages.find(item => item.id === target) : undefined
    return message ? { messages: [message], body: { status: 'available', message }, status: 'available' }
      : { messages: [], body: { status: `no_${part}`, message: null }, status: `no_${part}` }
  }
  return { messages, body: { status: 'available', messages }, status: 'available' }
}
export const dingtalkThreadContext: ThreadContext<{ readPageSize: number }> = {
  messageId: trigger => String(trigger.meta.msgId ?? ''),
  read: (commands, trigger, part, _cursor, config) => dingtalkRead(commands, trigger, part, config.readPageSize),
}
