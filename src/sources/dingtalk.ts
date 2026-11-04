/** DingTalk source kind definition, policy synchronization, Stream consumer wiring, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { z } from 'zod'
import { DingtalkBotSchema } from '../deployment.ts'
import { dingtalkLink, sendDingtalk } from './dingtalk-channel.ts'
import { dingtalkThreadContext } from './dingtalk-read.ts'
import { runDingtalk, setEventStream, setHistoryReader, setStreamError, type EventStream } from './dingtalk-loops.ts'
import { SOURCE, dingtalkTriggerId } from './dingtalk-trigger.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export { SOURCE, dingtalkRef, dingtalkThreadId, dingtalkTime, dingtalkTrigger, dingtalkTriggerId, historyEvent } from './dingtalk-trigger.ts'
export type { DingtalkEvent } from './dingtalk-trigger.ts'
export { consumerRetry, refreshConvNames, runDingtalk, setEventStream, setHistoryReader } from './dingtalk-loops.ts'
const DingtalkConfigSchema = DingtalkBotSchema.extend({
  readPageSize: z.number().int().min(1).max(50).default(20),
  linkTimeoutMs: z.number().int().min(1).max(90000).default(5000),
  chats: z.array(z.object({ conversationId: z.string().regex(/^[A-Za-z0-9+_=-]+$/), name: z.string().trim().max(60).optional(), listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.conversationId)).size === chats.length, 'Duplicate conversation IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type DingtalkConfig = z.infer<typeof DingtalkConfigSchema>
export const dingtalkKind: SourceKind<DingtalkConfig> = {
  kind: SOURCE,
  title: { zh: '钉钉', en: 'DingTalk' },
  description: { zh: '接收下列群和单聊中发给机器人的消息（钉钉 Stream 实时推送），并轮询订阅的线程。', en: 'Receives messages to the bot in these groups and direct messages through the DingTalk Stream, and polls subscribed Threads.' },
  schema: DingtalkConfigSchema,
  fields: [
    { key: 'appKey', type: 'text', label: { zh: '应用 AppKey', en: 'App AppKey' },
      hint: { zh: '企业内部应用的 AppKey。保存时用它和 AppSecret 换取 access_token、读取机器人信息，然后重启 dsh-superagent。', en: 'The AppKey of an enterprise internal app. Saving exchanges it and the AppSecret for an access token, reads the robot, then restarts dsh-superagent.' } },
    { key: 'appSecret', type: 'text', label: { zh: '应用 AppSecret', en: 'App AppSecret' },
      hint: { zh: '与 AppKey 配套的 AppSecret，仅用于换取 access_token；不要提交到仓库或写进日志。', en: 'The AppSecret paired with the AppKey, used only to obtain an access token; never commit it or write it to logs.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Groups' },
      hint: { zh: '“仅 @”只接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估可以按规则从中推断工作。', en: '"@ only" receives messages that mention the bot and Threads that have Tickets; "All" also receives the rest, from which Eval may infer work.' },
      columns: [
        { key: 'conversationId', type: 'text', label: { zh: '会话', en: 'Conversation' }, pattern: '[A-Za-z0-9+_=-]+', choose: { zh: '选择机器人所在的会话', en: 'Choose a conversation the bot is in' }, refresh: { zh: '刷新会话列表', en: 'Refresh conversations' } },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other groups' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }],
      hint: { zh: '机器人所在、但没列在上面的群。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。', en: 'Groups the bot is in that are not listed above. "@ only" receives messages there that mention the bot; whose messages may originate work is the Policy\'s admission.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收单聊', en: 'Direct messages' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页消息数', en: 'Messages per page' }, hint: { zh: '智能体读取线程时每页的消息数。', en: 'Messages per page when agents read Threads.' } },
    { key: 'linkTimeoutMs', type: 'number', advanced: true, min: 1, max: 90000, label: { zh: '原消息链接的查询时限 / 毫秒', en: 'Original message link time limit / ms' },
      hint: { zh: '查询原消息链接最多等待的时间；超时后智能体改为直接读取原消息。', en: 'How long to wait for an original message\'s link; after that, agents read the message itself.' } },
  ],
  health: ['dingtalk', 'dingtalkHistory'],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.conversationId === meta.conversationId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.conversationId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a conversation the Source still receives.
  channel: {
    allowed: (address, config) =>
      dingtalkKind.scope!({ meta: { conversationId: address.conversationId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendDingtalk, link: dingtalkLink,
  },
  threadContext: dingtalkThreadContext,
  find: query => ({ threads: [], terms: [...new Set(query.match(/\bmsg[A-Za-z0-9+/=_-]+\b/g) ?? [])] }),
  // A message's Trigger is named after the message, so the one it answers is named after its parent.
  repliesTo: trigger => typeof trigger.meta.parentId === 'string' ? dingtalkTriggerId(trigger.meta.parentId) : undefined,
  policy: {
    unnamed: { person: { zh: '钉钉用户', en: 'DingTalk user' }, bot: { zh: '钉钉机器人', en: 'DingTalk bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user IDs').default([]),
      bots: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的钉钉用户', en: 'DingTalk users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'staffId（或 senderId）', en: 'staffId (or senderId)' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        hint: { zh: '名单里的机器人在接收的会话里发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。其他机器人的消息不接收。', en: 'Messages of a bot on this list, in conversations the Source receives, become inferred candidates for an assessment; they never make an explicit request or stop a ticket. Other bots\' messages are not admitted.' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'senderId', en: 'senderId' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人 @ 机器人或单聊机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.' },
    rows(stored) {
      const config = DingtalkConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({ id: chat.conversationId, label: chat.name || chat.conversationId, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他群', en: 'Other groups' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '单聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_DINGTALK_BOT', description: { zh: '钉钉机器人；API 以它行事', en: 'The DingTalk robot; the API acts as it' } },
      { key: 'DSH_SUPERAGENT_DINGTALK_CONVERSATION', description: { zh: '接下工单的钉钉会话；工单不是从钉钉来的时为空', en: 'conversation id of the DingTalk chat that started the ticket; empty when the ticket did not start on DingTalk' } },
    ],
    values: ({ deployment, trigger }) => ({ DSH_SUPERAGENT_DINGTALK_BOT: deployment.dingtalk ? deployment.dingtalk.name || deployment.dingtalk.robotCode : '', DSH_SUPERAGENT_DINGTALK_CONVERSATION: trigger?.source === SOURCE ? String(trigger.meta.conversationId ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.dingtalk ? { appKey: { zh: `当前机器人 ${deployment.dingtalk.name || deployment.dingtalk.robotCode}`, en: `Current robot ${deployment.dingtalk.name || deployment.dingtalk.robotCode}` } } : {},
}
/** Returns the DingTalk Source's settings, falling back to schema defaults while the DingTalk plugin is disabled. */
export const dingtalkSettings = (sources: SourceRegistry): DingtalkConfig => sources.instance<DingtalkConfig>(SOURCE)?.config ?? DingtalkConfigSchema.parse({})

/**
 * Installs the default Stream consumer if the optional `dingtalk-stream` package is present, using the resolved app credentials.
 * When it is absent the Source still starts and reports that the consumer is not installed, rather than failing the app.
 */
async function installDefaultStream(): Promise<void> {
  // The SDK ships a CJS and an ESM build; the ESM one fails to evaluate on some Node/host combinations with an internal
  // assertion, so the CommonJS build is loaded first through `require`, falling back to a dynamic import only if that fails.
  type Client = new (options: { clientId: string; clientSecret: string }) =>
    { registerCallbackListener: (topic: string, cb: (res: { data: string }) => void) => void; connect: () => Promise<void>; disconnect?: () => void }
  let module: { DWClient?: Client } | undefined
  const failure: string[] = []
  try {
    const require = createRequire(import.meta.url)
    module = require('dingtalk-stream') as { DWClient?: Client }
  } catch (error) {
    failure.push(error instanceof Error ? `${error.message} (require)` : `${String(error)} (require)`)
    try {
      module = await import('dingtalk-stream' as string) as { DWClient?: Client }
    } catch (fallback) {
      failure.push(fallback instanceof Error ? `${fallback.message} (import)` : `${String(fallback)} (import)`)
      module = undefined
    }
  }
  const Client = module?.DWClient
  if (!Client) { setStreamError(failure.join(' | ').replaceAll(/\s+/g, ' ').trim() || 'the dingtalk-stream package exposes no DWClient export'); return }
  setStreamError(undefined)
  const stream: EventStream = async function* (ctx, signal, onReady) {
    const app = ctx.deployment.dingtalk
    if (!app) throw new Error('The DingTalk Source has no working app')
    const client = new Client({ clientId: app.appKey, clientSecret: app.appSecret })
    // A queue bridges the SDK's callback pushing into this async generator.
    const queue: unknown[] = []
    let wake: (() => void) | undefined
    let closed = false
    const push = (value: unknown): void => { queue.push(value); wake?.() }
    client.registerCallbackListener('/v1.0/im/bot/messages/get', response => {
      try { push(JSON.parse(response.data)) } catch { /* Malformed callback JSON is dropped. */ }
    })
    await client.connect()
    // The WebSocket is up: report ready now, before the first message arrives.
    onReady()
    try {
      while (!signal.aborted) {
        if (!queue.length) { await new Promise<void>(resolve => { wake = resolve }); wake = undefined; continue }
        yield queue.shift()
      }
    } finally { closed = true; void closed; client.disconnect?.() }
  }
  setEventStream(stream)
}

export const name = 'dsh-superagent-dingtalk'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(dingtalkKind), 'dingtalk: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    // Load the optional Stream consumer before the loop starts; absent, the loop reports it through the Source's health.
    const installed = installDefaultStream()
    const running = installed.then(() => runDingtalk(sourceContext(ctx.orchestrator, dingtalkKind), controller.signal))
    return async () => { controller.abort(); await running }
  })
}
