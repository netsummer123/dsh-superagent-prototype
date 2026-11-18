import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { PersonNotify, keyPoints, type PersonNotifyHost } from '../src/app/person-notify.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'
import { testDeployment } from './fixtures/deployment.ts'
import type { Ticket } from '../src/core/index.ts'

const STAFF = 'staff_alice'
const BOT = 'cls_dingbot'

/** A minimal ticket with the fields the notify loop reads. */
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 't-1', title: '在 README 标题加后缀', decisionId: 'd', mandate: {} as Ticket['mandate'], channels: [], assignments: [],
  inputs: [], undelivered: [], origin: { triggerId: '1', triggerIds: ['1'] }, createdAt: '', updatedAt: '',
  execution: { name: 'task-1', directory: '/tmp/t', assignment: 'x' }, ...over,
}) as Ticket

/** Build a PersonNotify host over a real Store, capturing DingTalk sends. `ctl.fail` makes the next sends throw. */
function host(tickets: Ticket[]): { notify: PersonNotify; sent: string[]; store: Store; dir: string; ctl: { fail: boolean } } {
  const dir = mkdtempSync(join(tmpdir(), 'pnotify-'))
  const store = new Store(join(dir, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { dingtalk: { allowed: [{ id: STAFF, name: 'Alice' }] } } } }))
  for (const t of tickets) store.tickets.save(t)
  const sent: string[] = []
  const ctl = { fail: false }
  const deployment = testDeployment({ dingtalk: { appKey: 'k', appSecret: 's', robotCode: BOT, name: 'Ding Bot' } })
  const deps: PersonNotifyHost = {
    store: store as PersonNotifyHost['store'],
    commands: { dingtalk: vi.fn(async (_path: string, body: Record<string, unknown>) => {
      if (ctl.fail) throw new Error('transport down')
      sent.push((JSON.parse(String(body.msgParam)) as { content: string }).content)
    }) },
    deployment: () => deployment,
    report: () => {},
    ok: () => {},
    appName: () => 'super-agent',
    panelUrl: () => 'http://panel/x',
  }
  return { notify: new PersonNotify(deps), sent, store, dir, ctl }
}
const ac = () => new AbortController()
let dirs: string[] = []
afterEach(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} } dirs = [] })
const mk = (tickets: Ticket[]) => { const h = host(tickets); dirs.push(h.dir); return h }

describe('person-notify key points', () => {
  it('decision key points name the action, the open question, the PR and the latest summary', () => {
    const t = ticket({ attention: { question: '用哪个标题？' } as Ticket['attention'],
      follows: [{ thread: 'PR #2', own: true }],
      assignments: [{ id: 'a', state: 'running', createdAt: '', report: { state: 'ready', summary: '已提交 README 改动', at: '' } }] })
    const points = keyPoints(t, { kind: 'decision', action: 'review' })
    expect(points.join('\n')).toContain('等你验收')
    expect(points.join('\n')).toContain('用哪个标题')
    expect(points.join('\n')).toContain('PR #2')
    expect(points.join('\n')).toContain('已提交 README 改动')
  })

  it('result key points name the outcome, the reason and the summary', () => {
    const t = ticket({ ended: { at: '', by: 'human', outcome: 'merged', reason: 'PR 已合并' },
      follows: [{ thread: 'PR #2', own: true, closed: { at: '', outcome: 'merged' } }],
      assignments: [{ id: 'a', state: 'ended', createdAt: '', report: { state: 'ready', summary: '任务完成', at: '' } }] })
    const points = keyPoints(t, { kind: 'result' })
    expect(points.join('\n')).toContain('已完成并合并')
    expect(points.join('\n')).toContain('PR 已合并')
    expect(points.join('\n')).toContain('任务完成')
  })
})

describe('PersonNotify scan', () => {
  it('pushes a decision message for a person-stage ticket, once', async () => {
    const h = mk([ticket({ assignments: [{ id: 'a', state: 'running', createdAt: '', report: { state: 'ready', summary: '完成', at: '' } }] })])
    await h.notify['scan'](ac().signal)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toContain('有工单需要你处理')
    expect(h.sent[0]).toContain('在 README 标题加后缀')
    // Second pass: already announced, no new send.
    await h.notify['scan'](ac().signal)
    expect(h.sent).toHaveLength(1)
  })

  it('seeds pre-existing ended tickets on the first pass without flooding, then pushes a new end once', async () => {
    // An already-ended ticket present on the very first pass is historical backlog: it is seeded, not pushed.
    const backlog = ticket({ id: 't-old', ended: { at: '2026-01-01T00:00:00.000Z', by: 'human', outcome: 'merged' } })
    const h = mk([backlog])
    await h.notify['scan'](ac().signal)
    expect(h.sent).toHaveLength(0) // backlog is not flooded on first run
    expect(h.store.get(KV.personNotify.endedWatermark)).toBeTruthy() // seeded marker set
    expect(h.store.get(KV.personNotify.ended)![`t-old|2026-01-01T00:00:00.000Z`]).toBeTruthy()
    // A ticket that ends AFTER seeding is pushed exactly once.
    h.store.tickets.save(ticket({ id: 't-new', ended: { at: '2026-06-01T00:00:00.000Z', by: 'human', outcome: 'merged', reason: 'PR 已合并' },
      assignments: [{ id: 'a', state: 'ended', createdAt: '', report: { state: 'ready', summary: '已合并', at: '' } }] }))
    await h.notify['scan'](ac().signal)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toContain('有一条工单已出结果')
    expect(h.sent[0]).toContain('已完成并合并')
    // Subsequent passes do not re-announce it.
    await h.notify['scan'](ac().signal)
    expect(h.sent).toHaveLength(1)
  })

  it('does not resurrect trimmed / evicted results as a storm across passes (notification-storm regression)', async () => {
    // Seed with an empty backlog so later ends are all "new".
    const h = mk([])
    await h.notify['scan'](ac().signal) // seeding pass, no sends
    for (let i = 0; i < 620; i++) h.store.tickets.save(ticket({ id: `t-${i}`, ended: { at: new Date(2026, 0, 1, 0, 0, i).toISOString(), by: 'human', outcome: 'completed' } }))
    await h.notify['scan'](ac().signal)
    expect(h.sent.length).toBe(620) // each new end pushed once
    // Further passes must not resurrect any id as a duplicate regardless of how many ended tickets there are.
    await h.notify['scan'](ac().signal)
    await h.notify['scan'](ac().signal)
    expect(h.sent.length).toBe(620)
  })

  it('retries a result whose send failed on the next pass, instead of losing it', async () => {
    const h = mk([])
    await h.notify['scan'](ac().signal) // seed
    h.store.tickets.save(ticket({ id: 't-flaky', ended: { at: '2026-02-02T00:00:00.000Z', by: 'human', outcome: 'completed' } }))
    // First attempt fails at the transport; the failure is not recorded, so it retries next pass.
    h.ctl.fail = true
    await h.notify['scan'](ac().signal)
    expect(h.sent).toHaveLength(0)
    expect(h.store.get(KV.personNotify.ended)![`t-flaky|2026-02-02T00:00:00.000Z`]).toBeFalsy() // not recorded on failure
    h.ctl.fail = false
    await h.notify['scan'](ac().signal)
    expect(h.store.get(KV.personNotify.ended)![`t-flaky|2026-02-02T00:00:00.000Z`]).toBeTruthy()
    expect(h.sent).toHaveLength(1)
  })

  it('announces a ticket that a resume ends again, exactly once per end', async () => {
    const h = mk([])
    await h.notify['scan'](ac().signal) // seed
    h.store.tickets.save(ticket({ id: 't-r', ended: { at: '2026-03-01T00:00:00.000Z', by: 'human', outcome: 'completed' } }))
    await h.notify['scan'](ac().signal)
    expect(h.sent).toHaveLength(1)
    // Resume then end again with a newer ended.at: announced once more, then stable.
    h.store.tickets.save(ticket({ id: 't-r', ended: { at: '2026-04-01T00:00:00.000Z', by: 'human', outcome: 'merged' } }))
    await h.notify['scan'](ac().signal)
    expect(h.sent).toHaveLength(2)
    await h.notify['scan'](ac().signal)
    expect(h.sent).toHaveLength(2)
  })

  it('announces a decision and a new result across passes without duplication', async () => {
    const open = ticket({ id: 't-open', assignments: [{ id: 'a', state: 'running', createdAt: '', report: { state: 'ready', summary: 's', at: '' } }] })
    const h = mk([open])
    await h.notify['scan'](ac().signal) // seed; the open ticket gets a decision push
    const decisionPushes = h.sent.length
    expect(decisionPushes).toBe(1)
    h.store.tickets.save(ticket({ id: 't-done', ended: { at: '2026-05-01T00:00:00.000Z', by: 'human', outcome: 'completed' } }))
    await h.notify['scan'](ac().signal)
    expect(h.sent).toHaveLength(decisionPushes + 1)
    await h.notify['scan'](ac().signal)
    expect(h.sent).toHaveLength(decisionPushes + 1)
  })
})
