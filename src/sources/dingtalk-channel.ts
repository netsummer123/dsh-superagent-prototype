/** DingTalk outbound channel: posts replies through the callback's session webhook, falling back to the robot send API, and builds chat links. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { dingtalkTriggerId } from './dingtalk-trigger.ts'

/** True when DingTalk permanently refuses delivery: an expired session webhook or a conversation the bot no longer serves. */
const gone = (error: unknown): boolean => error instanceof CliError && error.code !== undefined
  && (error.code === 310000 || error.code === 300006 || error.code === 300001 || /session|expire|invalid|not.*member/i.test(error.message))
/** Outbound message ids already delivered, so an Outbox retry in this process is not posted twice (DingTalk has no idempotency key). */
const delivered = new Set<string>()
/** A robot code is required by the send APIs; the app key stands in when the robot info did not report one. */
const robotCode = (commands: Pick<SourceContext['commands'], 'deployment'>): string => commands.deployment.dingtalk?.robotCode ?? ''
/**
 * Replies in the conversation of the target message. It first posts to the callback's session webhook, which answers in the
 * original thread; when that window has closed it sends through the robot API. A repeated message id is sent at most once.
 */
export async function sendDingtalk(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { conversationId, msgId, sessionWebhook, direct } = message.channel.address
  if (!conversationId) throw new Error('Missing DingTalk reply target')
  if (delivered.has(message.id)) return 'sent'
  const text = checkedImText(message.text)
  // A session webhook is one-shot and carries its own credential; prefer it so the reply lands in the original thread.
  if (sessionWebhook) {
    try {
      await commands.dingtalkWebhook(sessionWebhook, { msgtype: 'markdown', markdown: { title: 'reply', text },
        ...(direct === 'true' ? {} : { at: { isAtAll: false } }) })
      delivered.add(message.id)
      return 'sent'
    } catch (error) { if (!gone(error)) throw error /* Webhook window closed; fall back to the robot API below. */ }
  }
  try {
    if (direct === 'true') {
      await commands.dingtalk('/v1.0/robot/oToMessages/batchSend', { robotCode: robotCode(commands), userIds: [conversationId], msgKey: 'sampleMarkdown',
        msgParam: JSON.stringify({ title: 'reply', text }) })
    } else {
      await commands.dingtalk('/v1.0/robot/groupMessages/send', { robotCode: robotCode(commands), openConversationId: conversationId,
        msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: 'reply', text }) })
    }
  } catch (error) { if (gone(error)) return 'gone'; throw error }
  delivered.add(message.id)
  return 'sent'
}
/** Exposed for tests: forget which messages were delivered. */
export const clearDelivered = (): void => delivered.clear()
/** Chat link; the callback's session webhook is the only URL the payload carries, and the message id names the trigger. */
export const dingtalkLink = (address: Record<string, string>, _links: ChannelLinks): ChannelLink => ({
  url: address.sessionWebhook ?? '', label: { zh: '钉钉消息', en: 'DingTalk message' },
  ...address.msgId ? { triggerId: dingtalkTriggerId(address.msgId) } : {} })
