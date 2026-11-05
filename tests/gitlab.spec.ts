import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KV } from '../src/kv.ts'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { gitlabKind, GitlabConfigSchema, pollRound } from '../src/sources/gitlab.ts'
import { gitlabChannel, gitlabRef, issueTrigger, mergeRequestTrigger, noteTrigger, projectSlug, slugProject } from '../src/sources/gitlab-trigger.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'

const HOST = 'git.example.com:9001'
const PROJECT = 'group/sub/widgets'
const AGENT = 'agent-bot'

function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({
    policy: { sources: { gitlab: { allowed: [{ id: 'alice' }] } } }, eval: { mode: 'auto' },
    sources: { gitlab: { enabled: true, config: { host: HOST, cli: 'glab', observeIssues: true, projects: [{ path: PROJECT, listen: 'mentions' }, { path: 'group/other', listen: 'all' }] } } },
  })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(gitlabKind)
  const deployment = testDeployment({ gitlab: { cli: 'glab', host: HOST, login: AGENT, commitEmail: 'agent@example.com',
    projects: [{ path: PROJECT, id: 42, defaultBranch: 'main' }, { path: 'group/other', id: 43, defaultBranch: 'main' }] } })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const context = sourceContextOf(parts, { kind: 'gitlab', health: ['gitlab'] })
  return { ...parts, ...context, health: board.all, store, engine, commands, receive }
}
const note = (id: number, fields: Record<string, unknown> = {}) => ({ id, body: 'hello', author: { username: 'alice', name: 'Alice', bot: false },
  system: false, created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z', discussion_id: 'abc', web_url: `https://${HOST}/${PROJECT}/-/merge_requests/7#note_${id}`, ...fields })
const mr = (fields: Record<string, unknown> = {}) => ({ iid: 7, title: 'Fix', description: 'body', state: 'opened', author: { username: 'alice' },
  created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z', web_url: `https://${HOST}/${PROJECT}/-/merge_requests/7`,
  source_branch: 'agent/fix', target_branch: 'main', sha: 'abc1234', source_project_id: 42, ...fields })

describe('gitlab translation', () => {
  it('keys a note stably, groups it by project thread, and marks mention and bot senders', () => {
    const ref = { project: PROJECT, slug: projectSlug(PROJECT), iid: 7, kind: 'mr' as const }
    const trigger = noteTrigger(note(11, { body: 'hi @agent-bot please', author: { username: 'alice', bot: false } }), ref, AGENT)!
    expect(trigger).toMatchObject({ id: key('gitlab-note', `${PROJECT}!mr7`, '11', '2026-09-09T00:00:00Z'), source: 'gitlab',
      threads: [{ source: 'gitlab', id: `${projectSlug(PROJECT)}:7` }], actor: { source: 'gitlab', id: 'alice' }, human: true,
      channel: { source: 'gitlab', address: { project: PROJECT, slug: projectSlug(PROJECT), iid: '7', kind: 'mr', discussionId: 'abc' } } })
    expect(trigger.addressed).toBe('mention')
    const bot = noteTrigger(note(12, { author: { username: 'botuser', bot: true } }), ref, AGENT)!
    expect(bot.human).toBe(false)
    expect(trigger.id).not.toBe(bot.id)
  })
  it('produces no trigger for a system note or the agent\'s own note', () => {
    const ref = { project: PROJECT, slug: projectSlug(PROJECT), iid: 7, kind: 'mr' as const }
    expect(noteTrigger(note(1, { system: true }), ref, AGENT)).toBeUndefined()
    expect(noteTrigger(note(2, { author: { username: AGENT, bot: false } }), ref, AGENT)?.human).toBe(false)
  })
  it('builds issue and merge-request triggers with their own ids', () => {
    const issue = issueTrigger({ iid: 5, title: 'T', description: 'D', state: 'opened', author: { username: 'alice' },
      created_at: '2026-09-09T00:00:00Z', web_url: '' } as never, PROJECT, HOST, AGENT)
    expect(issue.id).toBe(key('gitlab-issue', `${PROJECT}#5`))
    expect(issue.threads[0]!.id).toBe(`${projectSlug(PROJECT)}:5`)
    const m = mergeRequestTrigger(mr() as never, PROJECT, HOST, AGENT)
    expect(m.id).toBe(key('gitlab-mr', `${PROJECT}!7`))
    expect(m.meta.kind).toBe('mr')
  })
  it('round-trips a project path through its slug', () => {
    expect(projectSlug('group/sub/widgets')).toBe('group~sub~widgets')
    expect(slugProject(projectSlug('group/sub/widgets'))).toBe('group/sub/widgets')
    expect(gitlabRef(mergeRequestTrigger(mr() as never, PROJECT, HOST, AGENT))).toMatchObject({ project: PROJECT, iid: 7, kind: 'mr' })
  })
})

describe('gitlab scope and policy', () => {
  const config = GitlabConfigSchema.parse({ host: HOST, cli: 'glab', projects: [{ path: PROJECT, listen: 'mentions' }, { path: 'group/other', listen: 'all' }] })
  it('receives a listed project only when it @s the agent, and an "all" project always', () => {
    expect(gitlabKind.scope!({ meta: { slug: projectSlug(PROJECT) } }, config)).toEqual({ listened: true, observed: false, row: projectSlug(PROJECT) })
    expect(gitlabKind.scope!({ meta: { slug: projectSlug('group/other') } }, config)).toEqual({ listened: true, observed: true, row: projectSlug('group/other') })
    expect(gitlabKind.scope!({ meta: { slug: projectSlug('group/unlisted') } }, config).listened).toBe(false)
    const ci = gitlabKind.scope!({ meta: { ci: true } }, config)
    expect(ci.listened && ci.row).toBe('ci')
  })
  it('lists one admission row per project plus the default-branch pipeline', () => {
    const rows = gitlabKind.policy!.rows!({ projects: [{ path: PROJECT, listen: 'mentions' }, { path: 'group/other', listen: 'all' }], observeCi: true })
    expect(rows.map(row => row.id)).toEqual([projectSlug(PROJECT), projectSlug('group/other'), 'ci'])
    expect(rows[1]!.cells.listedUnaddressed).toBe(true)
    expect(rows[0]!.cells.listedUnaddressed).toBe(false)
  })
})

describe('gitlab channel', () => {
  it('posts once per message id, finding its own marker on a retry', async () => {
    const h = host()
    const posted: unknown[] = []
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    vi.spyOn(h.commands, 'gitlabPages').mockResolvedValue([])
    vi.spyOn(h.commands, 'gitlabApi').mockImplementation(async (_project, _path, request) => { posted.push(request); return {} })
    const message = { id: 'out1', kind: 'reply' as const, text: 'done', channel: gitlabChannel({ project: PROJECT, slug: projectSlug(PROJECT), iid: 7, kind: 'mr' }) }
    expect(await sendGitlab(h, message)).toBe('sent')
    expect(posted).toHaveLength(1)
    // A retry finds the marker already on the server and posts nothing further.
    vi.spyOn(h.commands, 'gitlabPages').mockResolvedValue([{ id: 1, body: `done\n\n<!-- dsh-superagent:out1 -->` }])
    expect(await sendGitlab(h, message)).toBe('sent')
    expect(posted).toHaveLength(1)
  })
  it('reports gone for a deleted target and rethrows other failures', async () => {
    const h = host()
    vi.spyOn(h.commands, 'gitlabPages').mockResolvedValue([])
    const { CliError } = await import('../src/infra/commands.ts')
    vi.spyOn(h.commands, 'gitlabApi').mockRejectedValueOnce(new CliError('404 Not Found', 404))
    const base = { id: 'g1', kind: 'reply' as const, text: 'x', channel: gitlabChannel({ project: PROJECT, slug: projectSlug(PROJECT), iid: 9, kind: 'issue' }) }
    expect(await sendGitlab(h, base)).toBe('gone')
    vi.spyOn(h.commands, 'gitlabApi').mockRejectedValueOnce(new CliError('500 boom', 500))
    await expect(sendGitlab(h, { ...base, id: 'g2' })).rejects.toThrow('500')
  })
})

describe('gitlab poll round', () => {
  it('takes in a project\'s new Issues and merge requests, skipping its own and old items', async () => {
    const h = host()
    // A stream ignores items created before it was switched on, so pretend it was switched on a while ago.
    const past = new Date(Date.now() - 3600_000).toISOString()
    const now = new Date(Date.now() + 1000).toISOString()
    h.store.set(KV.gitlab.stream(projectSlug(PROJECT), 'issues') as never, { since: past, started: { issues: past } })
    // `withSignal` returns a fresh Commands normally; keep the stubbed instance so the spies below answer the poll.
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    vi.spyOn(h.commands, 'gitlabPages').mockImplementation(async (project, path) => {
      if (path.startsWith('issues')) return [
        { iid: 5, title: 'Bug', description: 'please @agent-bot', state: 'opened', author: { username: 'alice' }, created_at: now, updated_at: now, web_url: '' },
        { iid: 6, title: 'Own', description: '', state: 'opened', author: { username: AGENT }, created_at: now, updated_at: now, web_url: '' },
      ]
      if (path.startsWith('merge_requests')) return []
      return []
    })
    await pollRound(h, new AbortController().signal)
    const received = h.receive.mock.calls.map(call => call[0])
    expect(received.some(trigger => trigger.id === key('gitlab-issue', `${PROJECT}#5`))).toBe(true)
    expect(received.some(trigger => trigger.meta && (trigger.meta as { iid?: number }).iid === 6)).toBe(false)
    expect(h.engine.candidate(key('gitlab-issue', `${PROJECT}#5`))?.strength).toBe('explicit')
  })
})
