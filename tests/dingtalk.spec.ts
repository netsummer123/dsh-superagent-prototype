import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { dingtalkKind, dingtalkTrigger, dingtalkThreadId, dingtalkTime, dingtalkTriggerId, apply as applyDingtalk }
  from '../src/sources/dingtalk.ts'
import { dingtalkChannel } from '../src/sources/dingtalk-trigger.ts'
import { sendDingtalk, clearDelivered } from '../src/sources/dingtalk-channel.ts'
import { documentPaths } from '../src/sources/dingtalk-preview.ts'
import { runDingtalk, setEventStream, setHistoryReader, consumerRetry } from '../src/sources/dingtalk-loops.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { KV } from '../src/kv.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SetupError } from '../src/setup.ts'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STAFF = 'staff_alice'
const BOT = 'cls_dingbot'
/** Health boards by registry, so a host built on a supplied registry reads that registry's entries. */
const boards = new WeakMap<SourceRegistry, HealthBoard>()

function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'dingtalk-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({
    policy: { sources: { dingtalk: { allowed: [{ id: STAFF, name: 'Alice' }] } } }, eval: { mode: 'auto' },
    sources: { dingtalk: { enabled: true, config: { appKey: 'k', appSecret: 's', chats: [{ conversationId: 'cid_a', listen: 'mentions' },
      { conversationId: 'cid_observed', listen: 'all' }], directMessages: true } } },
  })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  boards.set(sources, board)
  const deployment = testDeployment({ dingtalk: { appKey: 'k', appSecret: 's', robotCode: BOT, name: 'Ding Bot' } })
  sources.register(dingtalkKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  const context = sourceContextOf(parts, { kind: 'dingtalk', health: ['dingtalk', 'dingtalkHistory'] })
  return { ...value, ...context, health: boards.get(parts.sources)?.all ?? board.all, store, engine, commands, receive, executor }
}
/** A robot callback event as the Stream delivers it. */
const event = (fields: Record<string, unknown> = {}) => ({ msgId: 'msg_1', conversationId: 'cid_a', conversationType: '2', senderId: 'sid_alice',
  senderStaffId: STAFF, senderNick: 'Alice', msgtype: 'text', text: { content: 'hello' }, atUsers: [], isInAtList: false,
  sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=abc', createAt: '1757376000000', ...fields })
const message = (msgId: string, fields: Record<string, unknown> = {}) => ({ msgId, conversationId: 'cid_a', senderId: STAFF, senderStaffId: STAFF,
  msgtype: 'text', content: `hi ${msgId}`, createAt: '1757376000000', ...fields })

afterEach(() => { setEventStream(async function* () {}) ; setHistoryReader(async () => []); clearDelivered() })

describe('dingtalk trigger translation', () => {
  it('keys a message stably, groups it by root, and marks @ or direct addressing', () => {
    const trigger = dingtalkTrigger(event({ rootId: 'msg_0', atUsers: [{ dingtalkId: BOT }], isInAtList: true }),
      { senderId: BOT })!
    expect(trigger).toMatchObject({ id: key('dingtalk', 'msg_1'), source: 'dingtalk', threads: [{ source: 'dingtalk', id: 'cid_a:msg_0' }],
      actor: { source: 'dingtalk', id: STAFF }, human: true, at: '2025-09-09T00:00:00.000Z', text: 'hello',
      channel: { source: 'dingtalk', address: { conversationId: 'cid_a', msgId: 'msg_1' } }, meta: { conversationId: 'cid_a', msgId: 'msg_1', direct: false, mentioned: true, rootId: 'msg_0' } })
    expect(trigger.addressed).toBe('mention')
    // A direct conversation is addressed directly, and its thread is keyed by the message alone.
    const direct = dingtalkTrigger(event({ conversationType: '1', msgId: 'msg_2' }), { senderId: BOT })!
    expect(direct.addressed).toBe('direct')
    expect(direct.threads[0]!.id).toBe('cid_a:msg_2')
    // No @ and not direct: no addressing.
    expect(dingtalkTrigger(event({ msgId: 'msg_3' }), { senderId: BOT })).not.toHaveProperty('addressed')
  })
  it('drops the bot\'s own messages by sender id or staff id', () => {
    expect(dingtalkTrigger(event({ senderStaffId: BOT }), { senderId: 'sid_other', staffId: BOT })).toBeUndefined()
    expect(dingtalkTrigger(event({ senderStaffId: undefined, senderId: BOT }), { senderId: BOT })).toBeUndefined()
  })
  it('formats its thread id and time, and parses epoch millis', () => {
    expect(dingtalkThreadId('cid', undefined, 'm1')).toBe('cid:m1')
    expect(dingtalkThreadId('cid', 'root', 'm1')).toBe('cid:root')
    expect(dingtalkTime('1757376000000')).toBe('2025-09-09T00:00:00.000Z')
    expect(dingtalkTriggerId('m1')).toBe(key('dingtalk', 'm1'))
  })
})

describe('dingtalk scope and policy', () => {
  it('receives configured groups, other groups by @, and direct messages per the switches', () => {
    const cfg = cfgOf()
    expect(dingtalkKind.scope!({ meta: { conversationId: 'cid_a' } }, cfg)).toEqual({ listened: true, observed: false, row: 'cid_a' })
    expect(dingtalkKind.scope!({ meta: { conversationId: 'cid_observed' } }, cfg)).toEqual({ listened: true, observed: true, row: 'cid_observed' })
    expect(dingtalkKind.scope!({ meta: { conversationId: 'cid_other' } }, cfg)).toEqual({ listened: true, observed: false, row: 'other' })
    expect(dingtalkKind.scope!({ meta: { direct: true } }, cfg)).toEqual({ listened: true, observed: false, row: 'direct' })
  })
  it('lists admission rows for each group, other groups and direct messages', () => {
    const rows = dingtalkKind.policy!.rows!({ chats: [{ conversationId: 'cid_a', listen: 'mentions' }, { conversationId: 'cid_observed', listen: 'all' }], directMessages: true, otherChats: 'mentions' })
    expect(rows.map(row => row.id)).toEqual(['cid_a', 'cid_observed', 'other', 'direct'])
    expect(rows.find(row => row.id === 'cid_observed')!.cells.listedUnaddressed).toBe(true)
    expect(rows.find(row => row.id === 'cid_a')!.cells.listedUnaddressed).toBe(false)
  })
})

describe('dingtalk stream consumer', () => {
  it('takes in what the stream yields, records each conversation, and evaluates an allowed mention as explicit', async () => {
    const h = host()
    let emitted = false
    setEventStream(async function* () {
      if (emitted) return
      emitted = true
      yield event({ msgId: 'msg_9', atUsers: [{ dingtalkId: BOT }], isInAtList: true })
      yield event({ msgId: 'msg_broken_skipped', text: undefined, msgId2: 'x' }) // harmless duplicate keys are validated loosely
    })
    const signal = new AbortController()
    // Consume one round of the loop; the generator ends, the loop restarts after a delay, so stop it.
    const running = runDingtalk(h, signal.signal)
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalled())
    signal.abort()
    await running
    expect(h.receive.mock.calls[0]![0].source).toBe('dingtalk')
    expect(h.engine.candidate(key('dingtalk', 'msg_9'))?.strength).toBe('explicit')
    // The known-conversation map records the conversation as not-direct.
    expect(h.store.get(KV.dingtalk.chats)).toMatchObject({ cid_a: false })
  })
})

describe('dingtalk channel', () => {
  it('replies through the session webhook once and prefers it over the API', async () => {
    const h = host()
    const webhook = vi.spyOn(h.commands, 'dingtalkWebhook').mockResolvedValue('sent')
    const sent = await sendDingtalk(h, { id: 'out1', kind: 'reply', text: 'done',
      channel: dingtalkChannel('cid_a', 'msg_1', false, 'https://oapi/session') })
    expect(sent).toBe('sent')
    expect(webhook).toHaveBeenCalledTimes(1)
  })
  it('falls back to the robot API when the webhook window closed, and reports a message gone only for permanent failures', async () => {
    const h = host()
    vi.spyOn(h.commands, 'dingtalkWebhook').mockResolvedValue('gone')
    const api = vi.spyOn(h.commands, 'dingtalk').mockResolvedValue({})
    expect(await sendDingtalk(h, { id: 'out2', kind: 'reply', text: 'done', channel: dingtalkChannel('cid_a', 'msg_1', false) })).toBe('sent')
    expect(api).toHaveBeenCalled()
    // No webhook: the API path answers gone for a removed conversation.
    const { CliError } = await import('../src/infra/commands.ts')
    vi.spyOn(h.commands, 'dingtalk').mockRejectedValueOnce(new CliError('not a member (300001)', 300001))
    expect(await sendDingtalk(h, { id: 'out3', kind: 'reply', text: 'done', channel: dingtalkChannel('cid_a', 'msg_2', false) })).toBe('gone')
  })
  it('delivers a repeated message id at most once', async () => {
    const h = host()
    const webhook = vi.spyOn(h.commands, 'dingtalkWebhook').mockResolvedValue('sent')
    const msg = { id: 'dup', kind: 'reply' as const, text: 'x', channel: dingtalkChannel('cid_a', 'msg_1', false, 'https://oapi/session') }
    expect(await sendDingtalk(h, msg)).toBe('sent')
    expect(await sendDingtalk(h, msg)).toBe('sent')
    expect(webhook).toHaveBeenCalledTimes(1)
  })
})

describe('dingtalk plugin', () => {
  it('registers its kind and names on its health what setup still needs', async () => {
    const h = host({ sources: emptyRegistry(), deployment: testDeployment({ dingtalk: undefined }) })
    const disposers: (() => unknown)[] = []
    applyDingtalk({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(h.health.dingtalk).toMatchObject({ state: 'paused', code: 'dingtalkAppUnset' }))
    expect(h.sources.kind('dingtalk')).toBe(dingtalkKind)
    const health = { ...h.health }
    for (const dispose of disposers) await dispose()
    expect(health.dingtalk).toMatchObject({ state: 'paused', code: 'dingtalkAppUnset' })
    // A failed app check waits for the operator's fix and a check.
    const problem = new SetupError('dingtalkCliFailed', {}).problem
    const ref = host({ sources: emptyRegistry(), deployment: testDeployment({ dingtalk: undefined }), dingtalkProblem: problem })
    const ds: (() => unknown)[] = []
    applyDingtalk({ orchestrator: ref, effect: (effect: () => () => unknown) => { ds.push(effect()) } } as never)
    await vi.waitFor(() => expect(ref.health.dingtalk).toMatchObject({ state: 'paused', detail: problem.detail }))
    for (const dispose of ds) await dispose()
  })
})

/** A registry without any kind, so a plugin entry's own registration is observable. */
function emptyRegistry(): SourceRegistry {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
  boards.set(sources, board)
  return sources
}

describe('dingtalk loop backoff', () => {
  it('waits a second after a run that stayed up a minute, otherwise backs off exponentially to 60s', () => {
    expect(consumerRetry(undefined, 0)).toBe(1000)
    expect(consumerRetry(undefined, 120_000)).toBe(1000)
    expect(consumerRetry(2000, 5000)).toBe(4000)
    expect(consumerRetry(40_000, 5000)).toBe(60_000)
  })
})

/** Builds a config identical to the fixture's, parsed through the kind's schema. */
function cfgOf() {
  return dingtalkKind.schema.parse({ chats: [{ conversationId: 'cid_a', listen: 'mentions' }, { conversationId: 'cid_observed', listen: 'all' }],
    directMessages: true, otherChats: 'mentions' })
}

describe('dingtalk robustness (phase 2)', () => {
  it('drops a stale token and retries the same call once after a 401 error', async () => {
    const h = host()
    let tokenFetches = 0
    let bodyCalls = 0
    h.commands.fetcher = async request => {
      if (request.url.includes('/oauth2/accessToken')) { tokenFetches++; return { status: 200, text: JSON.stringify({ accessToken: `tok${tokenFetches}` }) } }
      bodyCalls++
      // The first body call reports a stale token; the retried call succeeds.
      return bodyCalls === 1 ? { status: 401, text: JSON.stringify({ errmsg: 'token expired' }) }
        : { status: 200, text: JSON.stringify({ ok: true }) }
    }
    expect(await h.commands.dingtalk('/v1.0/robot/groupMessages/send', { robotCode: BOT, openConversationId: 'cid_a' })).toMatchObject({ ok: true })
    // A fresh token was fetched for the retry, and the body was called exactly twice.
    expect(tokenFetches).toBe(2)
    expect(bodyCalls).toBe(2)
  })
  it('reports a dedicated health entry when no Stream consumer is installed', async () => {
    // The assertion only holds when the optional `dingtalk-stream` SDK is not installed; on a host that has it (as a real
    // deployment does), apply() legitimately installs the consumer and the health becomes starting/ready instead.
    const sdkPresent = await import('dingtalk-stream' as string).then(() => true).catch(() => false)
    if (sdkPresent) return
    const { resetStream } = await import('../src/sources/dingtalk-loops.ts')
    resetStream()
    const h = host({ sources: emptyRegistry() })
    const disposers: (() => unknown)[] = []
    applyDingtalk({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(h.health.dingtalk).toMatchObject({ state: 'error', code: 'dingtalkStreamMissing' }))
    for (const dispose of disposers) await dispose()
  })
})

describe('dingtalk document preview', () => {
  /** A reply to a group whose session webhook answers; returns the Markdown the channel posted. */
  async function sentBody(h: ReturnType<typeof host>, text: string, id = 'preview'): Promise<string> {
    const webhook = vi.spyOn(h.commands, 'dingtalkWebhook').mockResolvedValue('sent')
    expect(await sendDingtalk(h, { id, kind: 'reply', text, channel: dingtalkChannel('cid_a', 'msg_1', false, 'https://oapi/session') })).toBe('sent')
    return (webhook.mock.calls[0]![1] as { markdown: { text: string } }).markdown.text
  }
  it('shows the local document a reply names, keeping the reply text first', async () => {
    const h = host()
    const document = join(mkdtempSync(join(tmpdir(), 'dingtalk-doc-')), '代码审查报告.md')
    writeFileSync(document, '# 结论\n\n发现 2 个问题。\n')
    const text = `审查完成。完整报告：\`${document}\``
    const body = await sentBody(h, text)
    expect(body.startsWith(text)).toBe(true)
    expect(body).toContain('**文档预览：代码审查报告.md**')
    expect(body).toContain('# 结论')
    expect(body).toContain('发现 2 个问题。')
  })
  it('labels an English reply\'s preview in English', async () => {
    const h = host()
    const document = join(mkdtempSync(join(tmpdir(), 'dingtalk-doc-')), 'review.md')
    writeFileSync(document, '# Findings\n')
    const body = await sentBody(h, `Done. Report: \`${document}\``)
    expect(body).toContain('**Document preview: review.md**')
    expect(body).toContain('# Findings')
  })
  it('sends the reply unchanged when a named path is missing, is not a document, or is not a file', async () => {
    const h = host()
    const directory = mkdtempSync(join(tmpdir(), 'dingtalk-doc-'))
    const source = join(directory, 'main.ts')
    writeFileSync(source, 'export {}\n')
    const folder = join(directory, 'notes.md')
    mkdirSync(folder)
    const text = `Done: \`${join(directory, 'missing.md')}\` \`${source}\` \`${folder}\``
    expect(await sentBody(h, text)).toBe(text)
  })
  it('cuts a long preview inside the message budget and says what it left out', async () => {
    const h = host()
    const document = join(mkdtempSync(join(tmpdir(), 'dingtalk-doc-')), 'long.md')
    const content = '# 报告\n\n' + '证据与建议。'.repeat(5000)
    writeFileSync(document, content)
    const body = await sentBody(h, `完成。报告：\`${document}\``)
    expect(body).toContain(`_（预览已截断，全文 ${[...content].length} 字）_`)
    expect(Buffer.byteLength(body)).toBeLessThan(14_000)
    expect(body.length).toBeLessThan(content.length)
  })
  it('ignores a document-looking URL, which is not a local document', () => {
    expect(documentPaths('See https://example.com/docs/review.md or `https://example.com/docs/notes.md`.')).toEqual([])
  })
  it('finds each named document once, keeping a path with spaces in a code span whole', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dingtalk-doc-'))
    const first = join(directory, 'first report.md')
    const second = join(directory, 'second.md')
    writeFileSync(first, '# one\n')
    writeFileSync(second, '# two\n')
    expect(documentPaths(`\`${first}\` and again ${second}, then ${second} and \`${join(directory, 'code.ts')}\``)).toEqual([first, second])
  })
})

describe('dingtalk thread context (phase 3)', () => {
  it('reads the conversation window through the installed history reader', async () => {
    const h = host()
    setHistoryReader(async () => [message('m1'), message('m0', { createAt: '1757376060000' })])
    const trigger = dingtalkTrigger(event({ msgId: 'm1', rootId: undefined }), { senderId: BOT })!
    const context = dingtalkKind.threadContext!
    const page = await context.read(h.commands, trigger, 'thread', undefined, cfgOf())
    expect(page.status).toBe('available')
    expect(page.messages.map(m => m.id)).toEqual(['m1', 'm0'])
    expect(context.messageId(trigger)).toBe('m1')
  })
  it('reports unavailable when the reader has no history, so assessment falls back to the trigger text', async () => {
    const h = host()
    setHistoryReader(async () => [])
    const trigger = dingtalkTrigger(event({ msgId: 'm1' }), { senderId: BOT })!
    const page = await dingtalkKind.threadContext!.read(h.commands, trigger, 'thread', undefined, cfgOf())
    expect(page.status).toBe('unavailable')
    expect(page.messages).toEqual([])
  })
  it('reads the parent message when the history holds it', async () => {
    const h = host()
    const parent = message('p0')
    setHistoryReader(async (_commands, input) => input.msgId === 'm1' ? [parent, message('m1')] : [])
    const trigger = dingtalkTrigger(event({ msgId: 'm1', parentId: 'p0', rootId: 'p0' }), { senderId: BOT })!
    const page = await dingtalkKind.threadContext!.read(h.commands, trigger, 'parent', undefined, cfgOf())
    expect(page.status).toBe('available')
    expect(page.messages.map(m => m.id)).toEqual(['p0'])
  })
})
