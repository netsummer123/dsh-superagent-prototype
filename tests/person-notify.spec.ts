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

/** Build a PersonNotify host over a real Store, capturing DingTalk sends. */
function host(tickets: Ticket[]): { notify: PersonNotify; sent: string[]; store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pnotify-'))
  const store = new Store(join(dir, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { dingtalk: { allowed: [{ id: STAFF, name: 'Alice' }] } } } }))
  for (const t of tickets) store.tickets.save(t)
  const sent: string[] = []
  const deployment = testDeployment({ dingtalk: { appKey: 'k', appSecret: 's', robotCode: BOT, name: 'Ding Bot' } })
  const deps: PersonNotifyHost = {
    store: store as PersonNotifyHost['store'],
    commands: { dingtalk: vi.fn(async (_path: string, body: Record<string, unknown>) => {
      sent.push((JSON.parse(String(body.msgParam)) as { content: string }).content)
    }) },
    deployment: () => deployment,
    report: () => {},
    ok: () => {},
    appName: () => 'super-agent',
    panelUrl: () => 'http://panel/x',
  }
  return { notify: new PersonNotify(deps), sent, store, dir }
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

  it('pushes a result message when a ticket ends, once', async () => {
    const h = mk([ticket({ ended: { at: '', by: 'human', outcome: 'merged', reason: 'PR 已合并' },
      assignments: [{ id: 'a', state: 'ended', createdAt: '', report: { state: 'ready', summary: '已合并', at: '' } }] })])
    await h.notify['scan'](ac().signal)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toContain('有一条工单已出结果')
    expect(h.sent[0]).toContain('已完成并合并')
    // A later ended ticket will not be re-announced.
    await h.notify['scan'](ac().signal)
    expect(h.sent).toHaveLength(1)
    expect(h.store.get(KV.personNotify.ended)![ticket().id]).toBeTruthy()
  })

  it('announces both a decision and a result across passes without duplication', async () => {
    const open = ticket({ id: 't-open', assignments: [{ id: 'a', state: 'running', createdAt: '', report: { state: 'ready', summary: 's', at: '' } }] })
    const done = ticket({ id: 't-done', ended: { at: '', by: 'human', outcome: 'completed' } })
    const h = mk([open, done])
    await h.notify['scan'](ac().signal)
    expect(h.sent).toHaveLength(2)
    await h.notify['scan'](ac().signal)
    expect(h.sent).toHaveLength(2)
  })
})
