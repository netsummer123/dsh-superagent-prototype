/** Normalizes DingTalk robot callbacks and history items into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'dingtalk'
/** Constructs a DingTalk reply channel address; `direct` marks a one-to-one conversation, whose id shares the group's shape. */
export const dingtalkChannel = (conversationId: string, msgId: string, direct = false, sessionWebhook?: string): ChannelRef =>
  ({ source: SOURCE, thread: `dingtalk:${conversationId}`, address: {
    conversationId, msgId, ...(direct ? { direct: 'true' } : {}), ...(sessionWebhook ? { sessionWebhook } : {}) } })
/** A robot callback as DingTalk delivers it to a Stream connection; `conversationType` is '1' for one-to-one, '2' for a group. */
const EventSchema = z.object({
  msgId: z.string(),
  conversationId: z.string(),
  conversationType: z.enum(['1', '2']),
  senderId: z.string(),
  senderStaffId: z.string().optional(),
  senderNick: z.string().optional(),
  msgtype: z.string(),
  text: z.object({ content: z.string().default('') }).optional(),
  atUsers: z.array(z.object({ dingtalkId: z.string(), staffId: z.string().optional() })).default([]),
  isInAtList: z.boolean().default(false),
  sessionWebhook: z.url().optional(),
  sessionWebhookExpiredTime: z.number().optional(),
  createAt: z.union([z.string(), z.number()]),
  rootId: z.string().optional(),
  parentId: z.string().optional(),
})
export type DingtalkEvent = z.infer<typeof EventSchema>
/** A message as the history API lists it, which omits the robot-only callback fields. */
export const HistoryMessageSchema = z.looseObject({
  msgId: z.string(), conversationId: z.string(), senderId: z.string(), senderStaffId: z.string().optional(),
  msgtype: z.string().optional(), content: z.string().optional(), createAt: z.union([z.string(), z.number()]),
  conversationType: z.enum(['1', '2']).optional(), rootId: z.string().optional(), parentId: z.string().optional(),
})
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>
/** The stable Trigger id of a DingTalk message; every read path for it produces the same id. */
export const dingtalkTriggerId = (msgId: string): string => key('dingtalk', msgId)
export const dingtalkThreadId = (conversationId: string, rootId: string | undefined, msgId: string): string => `${conversationId}:${rootId ?? msgId}`
/** Parses a DingTalk timestamp, epoch milliseconds as a string or number, into an ISO-8601 string. */
export function dingtalkTime(value: string | number): string {
  const time = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(time)) throw new Error(`Unreadable DingTalk message time: ${value}`)
  return new Date(time).toISOString()
}
/**
 * Converts a normalized DingTalk event into a Trigger, returning undefined for messages the bot itself sent.
 * `addressed` is `direct` for a one-to-one conversation and `mention` when the message @-ed the bot in a group.
 */
export function dingtalkTrigger(input: unknown, bot: { senderId: string; staffId?: string }): Trigger | undefined {
  const event = EventSchema.parse(input)
  if (event.senderId === bot.senderId || (bot.staffId && event.senderStaffId === bot.staffId)) return undefined
  const direct = event.conversationType === '1'
  const mentioned = event.isInAtList || event.atUsers.some(user => user.dingtalkId === bot.senderId || (bot.staffId && user.staffId === bot.staffId))
  const thread = dingtalkThreadId(event.conversationId, event.rootId, event.msgId)
  return { id: dingtalkTriggerId(event.msgId), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: event.senderStaffId ?? event.senderId }, human: true,
    ...(direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {}),
    at: dingtalkTime(event.createAt), text: event.text?.content ?? '',
    channel: dingtalkChannel(event.conversationId, event.msgId, direct, event.sessionWebhook),
    ...(event.sessionWebhook ? { url: event.sessionWebhook } : {}),
    meta: { conversationId: event.conversationId, msgId: event.msgId, direct, mentioned,
      ...(event.senderNick ? { senderNick: event.senderNick } : {}),
      ...(event.rootId ? { rootId: event.rootId } : {}), ...(event.parentId ? { parentId: event.parentId } : {}),
      ...(event.sessionWebhook ? { sessionWebhook: event.sessionWebhook } : {}) } }
}
export const dingtalkParent = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.parentId === 'string' ? dingtalkTriggerId(trigger.meta.parentId) : undefined
/** A message read from the history API, adapted to the same shape `dingtalkTrigger` accepts. */
export function historyEvent(message: HistoryMessage, direct: boolean): unknown {
  return { msgId: message.msgId, conversationId: message.conversationId, conversationType: direct ? '1' : '2',
    senderId: message.senderId, ...(message.senderStaffId ? { senderStaffId: message.senderStaffId } : {}),
    msgtype: message.msgtype ?? 'text', text: { content: message.content ?? '' }, atUsers: [], isInAtList: false,
    createAt: message.createAt, ...(message.rootId ? { rootId: message.rootId } : {}), ...(message.parentId ? { parentId: message.parentId } : {}) }
}
export interface DingtalkRef { triggerId: string; conversationId: string; msgId: string; at?: string }
export function dingtalkRef(trigger: Trigger): DingtalkRef | undefined {
  const meta = trigger.meta as { conversationId?: string; msgId?: string }
  if (trigger.source !== SOURCE || !meta.conversationId || !meta.msgId) return undefined
  return { triggerId: trigger.id, conversationId: meta.conversationId, msgId: meta.msgId, at: trigger.at }
}
