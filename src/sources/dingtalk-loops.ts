/** DingTalk background loops: the Stream event consumer, optional history backfill, chat name refresh, and subscribed-thread polling. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { threadKey, type Thread, type Trigger } from '../core/index.ts'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import { historyEvent, HistoryMessageSchema, dingtalkRef, dingtalkTrigger, SOURCE, type DingtalkRef, type HistoryMessage }
  from './dingtalk-trigger.ts'
import { health, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, pollThreads as pollEach } from './poll.ts'
import type { DingtalkConfig } from './dingtalk.ts'

/** Yields raw DingTalk robot-callback JSON as the Stream connection delivers it; ends when `signal` aborts. */
export interface EventStream { (ctx: SourceContext, signal: AbortSignal, onReady: () => void): AsyncIterable<unknown> }
/** Reads a bounded window of a conversation's messages for the optional backfill, thread poll and context reads; a gap returns nothing. */
export interface HistoryReader { (commands: Commands, input: { conversationId: string; msgId?: string; since: string; until: string; maxResults: number }): Promise<unknown[]> }
/** The event source and history reader the plugin installs; tests replace them with fakes. */
let eventStream: EventStream = unavailableStream
let historyReader: HistoryReader = unsupportedHistory
/** Whether a real Stream consumer was installed; the default placeholder reports `dingtalkStreamMissing` instead of retrying. */
let streamInstalled = false
/** Why installing the Stream consumer failed (usually the SDK import), shown on the health entry so the cause is not swallowed. */
let streamErrorValue: string | undefined
export const setEventStream = (stream: EventStream): void => { eventStream = stream; streamInstalled = true; streamErrorValue = undefined }
export const setStreamError = (message: string | undefined): void => { streamErrorValue = message }
export const streamError = (): string | undefined => streamErrorValue
export const setHistoryReader = (reader: HistoryReader): void => { historyReader = reader }
/** Whether an event source other than the placeholder is in place. */
export const hasStream = (): boolean => streamInstalled
/** Test seam: restore the placeholder consumer so the missing-Stream health can be exercised. */
export const resetStream = (): void => { eventStream = unavailableStream; streamInstalled = false }
/** Runs the installed history reader with `input`, as the loops and the thread context use it. */
export const readHistory = (commands: Commands, input: Parameters<HistoryReader>[1]): Promise<unknown[]> => historyReader(commands, input)
/** The default consumer: no Stream SDK is bundled, so the Source reports that one is required until the plugin supplies one. */
async function* unavailableStream(): AsyncIterable<unknown> {
  throw new Error('The DingTalk Stream consumer is not installed')
}
/** The default history reader: DingTalk exposes no group history through the robot, so backfill is a no-op until installed. */
function unsupportedHistory(): Promise<unknown[]> { return Promise.resolve([]) }

export const runDingtalk = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> =>
  Promise.allSettled([watch, backfillLoop, chatNamesLoop].map(loop => loop(ctx, signal)))
const enabled = (ctx: SourceContext): DingtalkConfig | undefined => ctx.config<DingtalkConfig>(SOURCE)
function available(ctx: SourceContext): boolean {
  if (ctx.configured() && ctx.deployment.dingtalk) return true
  const waiting = health('paused', ctx.configured() ? 'dingtalkAppUnset' : 'setupPending')
  ctx.report('dingtalk', ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
  return false
}
async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  const conversationId = String(trigger.meta.conversationId ?? '')
  if (!conversationId) return
  const name = ctx.state.get(KV.sources.labels(SOURCE))?.[conversationId] ?? conversationId
  const chat = trigger.meta.direct === true ? { value: { zh: '单聊', en: 'Direct message' } } : { value: name }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { chat } })
}

/** Runs the Stream consumer while the Source is enabled; a failure escapes as the Source's health and the loop retries. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) return
  // No Stream consumer in place: report once and stop, rather than retrying a connection that cannot be made. The detail
  // carries why installing it failed, so a missing or broken SDK is diagnosable from the panel.
  if (!streamInstalled) {
    const problem = health('error', 'dingtalkStreamMissing')
    ctx.report('dingtalk', streamErrorValue ? { ...problem, detail: `${problem.detail}: ${streamErrorValue}` } : problem)
    return
  }
  let retry: number | undefined
  while (!signal.aborted) {
    if (!enabled(ctx)) {
      ctx.report('dingtalk', health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const running = new AbortController()
    const link = () => running.abort()
    signal.addEventListener('abort', link, { once: true })
    const began = Date.now()
    let ready = false
    const markReady = () => { if (!ready) { ready = true; ctx.report('dingtalk', { state: 'ready', detail: 'Listening for bot events', at: new Date().toISOString() }) } }
    try {
      ctx.report('dingtalk', { state: 'starting', detail: 'Connecting to the DingTalk Stream' })
      for await (const event of eventStream(ctx, running.signal, markReady)) {
        markReady()
        if (signal.aborted || !enabled(ctx)) break
        const trigger = dingtalkTrigger(event, botOf(ctx))
        if (!trigger) continue
        const chats = ctx.state.get(KV.dingtalk.chats) ?? {}
        chats[String(trigger.meta.conversationId)] = trigger.meta.direct === true
        ctx.state.set(KV.dingtalk.chats, chats)
        await receive(ctx, trigger)
      }
    } catch (error) {
      if (!running.signal.aborted) ctx.report('dingtalk', { state: 'error', detail: String(error) })
    } finally { signal.removeEventListener('abort', link) }
    if (running.signal.aborted) continue
    retry = consumerRetry(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}
const botOf = (ctx: SourceContext): { senderId: string; staffId?: string } => {
  const dingtalk = ctx.deployment.dingtalk
  if (!dingtalk) throw new Error('The DingTalk Source has no working app')
  // The robot's own sender id equals its AppKey-basis robot code until setup resolves a finer id; comparing both guards self-echo.
  return { senderId: dingtalk.robotCode }
}
/** Wait before restarting the consumer: 1s after a run that stayed up a minute, else exponential backoff up to 60s. */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)

/** Refreshes the map of joined conversation names (`conversationId -> name`); throws on failure so the stored list stays. */
export async function refreshConvNames(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>> {
  const commands = ctx.commands.withSignal(signal)
  const result = z.looseObject({ result: z.looseObject({ result: z.array(z.looseObject({ openConversationId: z.string(), name: z.string().nullish() })).optional() }).optional() })
    .parse(await commands.dingtalk('/v1.0/im/conversations/lists', undefined).catch(() => ({ result: {} })))
  const list = result.result?.result ?? []
  const names = Object.fromEntries(list.filter(chat => chat.name).map(chat => [chat.openConversationId, chat.name!]))
  ctx.state.set(KV.sources.labels(SOURCE), names)
  return names
}
/** Rereads conversation names every minute; failures are ignored since names are only a display aid. */
async function chatNamesLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) return
  while (!signal.aborted) {
    if (enabled(ctx)) { try { await refreshConvNames(ctx, signal) } catch { /* Keep the stored list until a later read succeeds. */ } }
    await delay(60_000, undefined, { signal }).catch(() => {})
  }
}

async function backfillLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) { ctx.report('dingtalkHistory', health('paused', 'dingtalkAppUnset')); return }
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      ctx.report('dingtalkHistory', health('paused', 'sourceOff'))
      await delay(60_000, undefined, { signal }).catch(() => {})
      continue
    }
    // DingTalk exposes no bot-visible group history, so backfill reads only directed messages per known direct chat.
    const seen = ctx.state.get(KV.dingtalk.chats) ?? {}
    const known = Object.entries(seen).filter(([, direct]) => direct && config.directMessages)
    const errors: string[] = []
    const tally = { skipped: 0 }
    for (const [conversationId, direct] of known) {
      if (signal.aborted) break
      const started = new Date().toISOString()
      const cursorKey = KV.dingtalk.history(conversationId)
      const since = ctx.state.get(cursorKey)
      if (since === undefined) { ctx.state.set(cursorKey, started); continue }
      try {
        await backfillConversation(ctx, conversationId, direct, since, started, signal, tally)
        if (!signal.aborted) ctx.state.set(cursorKey, cursorAt(started))
      } catch (error) { if (!signal.aborted) errors.push(`${conversationId}: ${String(error)}`) }
    }
    await pollThreads(ctx, signal, tally)
    const skipped = tally.skipped ? `; ${tally.skipped} unreadable messages skipped` : ''
    if (!signal.aborted) ctx.report('dingtalkHistory', errors.length
      ? { state: 'error', detail: errors.join('\n') }
      : { state: 'ready', detail: `Known direct chats recovered${skipped}`, at: new Date().toISOString() })
    await delay(60_000, undefined, { signal }).catch(() => {})
  }
}

/**
 * Backfills one direct conversation's messages between `since` and `until`. DingTalk offers no group history through the robot,
 * so only one-to-one chats are recoverable, and a reader that answers nothing simply yields no triggers.
 */
export async function backfillConversation(ctx: SourceContext, conversationId: string, direct: boolean, since: string, until: string,
  signal: AbortSignal, tally: Tally = { skipped: 0 }): Promise<void> {
  if (!direct) return
  const items = await historyReader(ctx.commands.withSignal(signal), { conversationId, since, until, maxResults: 50 })
  for (const message of validItems(HistoryMessageSchema, items, tally)) {
    if (signal.aborted) return
    if (message.conversationId !== conversationId) throw new Error('DingTalk history returned a message outside the requested conversation')
    const trigger = dingtalkTrigger(historyEvent(message as HistoryMessage, direct), botOf(ctx))
    if (trigger) await receive(ctx, trigger)
  }
}

/** Resolves the retained source message reference for polling a subscribed thread. */
export function threadRef(ctx: SourceContext, thread: Thread): DingtalkRef | undefined {
  const meta = thread.meta as { sourceTriggerId?: string; conversationId?: string; msgId?: string }
  if (meta.conversationId && meta.msgId && meta.sourceTriggerId) {
    return { triggerId: meta.sourceTriggerId, conversationId: meta.conversationId, msgId: meta.msgId }
  }
  const trigger = ctx.triggers.latest(thread.key)
  return trigger ? dingtalkRef(trigger) : undefined
}

/**
 * Reads a bounded window of a Trigger's conversation through the installed history reader and returns it as context
 * messages, oldest first. It reads the same reader the backfill and poll use, so an installation that has none returns an
 * empty window (assessment then relies on the Trigger text alone).
 */
export async function readConversation(commands: Commands, ref: DingtalkRef, pageSize: number): Promise<unknown[]> {
  const since = ref.at ?? new Date(0).toISOString()
  return historyReader(commands, { conversationId: ref.conversationId, msgId: ref.msgId, since, until: new Date().toISOString(), maxResults: pageSize })
}

/** Polls subscribed DingTalk threads within the horizon so replies the Stream missed become triggers. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, tally?: Tally): Promise<void> {
  await pollEach(ctx, SOURCE, () => !!signal?.aborted, thread => pollThread(ctx, thread, signal, tally))
}
async function pollThread(ctx: SourceContext, thread: Thread, signal?: AbortSignal, tally?: Tally): Promise<void> {
  const ref = threadRef(ctx, thread)
  if (!ref) throw new Error('Subscribed thread has no retained source message')
  const config = enabled(ctx)
  if (!config) return
  const checkpoint = KV.dingtalk.seen(thread.key)
  const known = new Set(ctx.state.get(checkpoint) ?? [])
  const initialized = ctx.state.get(KV.dingtalk.initialized(thread.key))
  const direct = ctx.state.get(KV.dingtalk.chats)?.[ref.conversationId] === true
  const since = Date.parse(thread.createdAt)
  const items = await historyReader(ctx.commands.withSignal(signal), { conversationId: ref.conversationId, msgId: ref.msgId, since: thread.createdAt,
    until: new Date().toISOString(), maxResults: config.readPageSize })
  const messages = validItems(HistoryMessageSchema, items, tally)
  const bot = botOf(ctx)
  for (const message of messages) {
    if (signal?.aborted) return
    if (known.has(message.msgId)) continue
    const trigger = dingtalkTrigger(historyEvent(message as HistoryMessage, direct), bot)
    if (!trigger || (!initialized && Date.parse(trigger.at) < since)) continue
    await receive(ctx, trigger)
    known.add(message.msgId)
  }
  ctx.state.set(checkpoint, [...known])
  ctx.state.set(KV.dingtalk.initialized(thread.key), true)
}
