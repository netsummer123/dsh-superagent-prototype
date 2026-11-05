import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsSchema } from '../src/policy.ts'
import { findRepo, ticketExecution, projectOccupied } from '../src/executor/dsh.ts'
import { projectsSection } from '../src/app/prompts.ts'
import { environmentOf, ticketEnvironment } from '../src/app/execution-environment.ts'
import type { AssessmentOutcome, Ticket } from '../src/core/index.ts'
import type { SourceRegistry } from '../src/sources/registry.ts'
import type { Deployment } from '../src/deployment.ts'

const STATE = 'D:\\state'

const settings = (executor: Record<string, unknown> = {}, projects: Record<string, unknown> = {}) => SettingsSchema.parse({ executor, projects })

const ticket = (): Ticket => ({
  id: 'tkt-abcdef1234567890',
  title: 'Fix the landing page spacing',
  decisionId: 'd1',
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'addressed', addressed: 'mention' }, actor: { source: 'dingtalk', id: 'u1' }, scope: 'ui' },
  channels: [], assignments: [], inputs: [], undelivered: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  origin: { triggerId: 'tr1', triggerIds: ['tr1'] },
})

const accept = (name: string, project?: string): Extract<AssessmentOutcome, { kind: 'accept' }> =>
  ({ kind: 'accept', title: 't', scope: 's', reason: 'r', name, ...(project ? { project } : {}) })

const PROJECTS = [
  { name: 'DSH SuperAgent', path: 'D:\\work\\dsh-superagent', keywords: ['superagent', 'agent'] },
  { name: 'Demo Web', path: 'D:\\work\\demo-web', keywords: ['landing page', '官网'] },
]

describe('findRepo (which directory a project develops in)', () => {
  const make = () => mkdtempSync(join(tmpdir(), 'dsh-find-repo-'))
  const repo = (path: string) => { mkdirSync(join(path, '.git'), { recursive: true }); return path }

  it('uses the project directory itself when it is a repository', async () => {
    const root = repo(make())
    expect(await findRepo(root)).toBe(root)
  })

  it('uses the only repository inside a project that also holds materials', async () => {
    const root = make()
    mkdirSync(join(root, 'docs'), { recursive: true })
    const web = repo(join(root, 'web'))
    expect(await findRepo(root)).toBe(web)
  })

  it('develops in place when there is no repository, or several competing ones', async () => {
    const plain = make()
    mkdirSync(join(plain, 'docs'), { recursive: true })
    expect(await findRepo(plain)).toBeUndefined()
    const several = make()
    repo(join(several, 'web'))
    repo(join(several, 'api'))
    expect(await findRepo(several)).toBeUndefined()
  })

  it('ignores node_modules and dotted directories, and a missing project directory', async () => {
    const root = make()
    repo(join(root, 'node_modules'))
    repo(join(root, '.cache'))
    expect(await findRepo(root)).toBeUndefined()
    expect(await findRepo(join(root, 'nope'))).toBeUndefined()
  })
})

describe('work tree routing in ticketExecution', () => {
  it('defers the choice to preparation: a project ticket is planned at the project directory', () => {
    const execution = ticketExecution(ticket(), accept('fix-spacing', 'Demo Web'), settings({}, { items: PROJECTS }), STATE)
    expect(execution.directory).toBe('D:\\work\\demo-web')
    expect(execution.repo).toBeUndefined()
    expect(execution.project).toBe('Demo Web')
  })
})

describe('project routing in ticketExecution', () => {
  it('uses the matched project path as the workspace and records its name', () => {
    const execution = ticketExecution(ticket(), accept('fix-spacing', 'Demo Web'), settings({}, { items: PROJECTS }), STATE)
    expect(execution.directory).toBe('D:\\work\\demo-web')
    expect(execution.project).toBe('Demo Web')
    expect(execution.name).toBe('fix-spacing-tkt-abcdef12')
  })

  it('matches a project that lists no keywords by its name alone', () => {
    const keywordless = [{ name: 'Demo Web', path: 'D:\\work\\demo-web', keywords: [] }]
    const execution = ticketExecution(ticket(), accept('fix-spacing', 'Demo Web'), settings({}, { items: keywordless }), STATE)
    expect(execution.project).toBe('Demo Web')
    expect(execution.directory).toBe('D:\\work\\demo-web')
  })

  it('falls back to the execution root when the assessment names no project', () => {
    const execution = ticketExecution(ticket(), accept('fix-spacing'), settings({}, { items: PROJECTS }), STATE)
    expect(execution.directory).toBe(join(join(STATE, 'work'), 'fix-spacing-tkt-abcdef12'))
    expect(execution.project).toBeUndefined()
  })

  it('falls back when the named project is unknown, never throwing', () => {
    const unknown = ticketExecution(ticket(), accept('fix-spacing', 'nope'), settings({}, { items: PROJECTS }), STATE)
    expect(unknown.project).toBeUndefined()
    expect(unknown.directory).toBe(join(join(STATE, 'work'), 'fix-spacing-tkt-abcdef12'))
  })

  it('honours a configured ticket directory root when no project matches', () => {
    const execution = ticketExecution(ticket(), accept('fix-spacing'), settings({ directory: 'D:\\root' }, { items: PROJECTS }), STATE)
    expect(execution.directory).toBe(join('D:\\root', 'fix-spacing-tkt-abcdef12'))
  })
})

describe('ProjectsConfigSchema', () => {
  it('defaults to an empty registry that falls back to the ticket directory', () => {
    expect(SettingsSchema.parse({}).projects).toEqual({ items: [], matchFallback: 'directory' })
  })

  it('accepts a project whose keywords are omitted, and an invalid absolute path fails', () => {
    const parsed = SettingsSchema.parse({ projects: { items: [{ name: 'Demo', path: 'D:\\work\\demo' }] } })
    expect(parsed.projects.items[0]!.keywords).toEqual([])
    expect(SettingsSchema.safeParse({ projects: { items: [{ name: 'Demo', path: 'relative/dir' }] } }).success).toBe(false)
  })

  it('refuses two projects with the same name', () => {
    const duplicate = { items: [{ name: 'Demo', path: 'D:\\a' }, { name: 'demo ', path: 'D:\\b' }] }
    expect(SettingsSchema.safeParse({ projects: duplicate }).success).toBe(false)
  })

  it('keeps three fields only: name, directory and keywords', () => {
    const parsed = SettingsSchema.parse({ projects: { items: [{ name: 'A', path: 'D:\\a', keywords: ['x'] }] } })
    expect(Object.keys(parsed.projects.items[0]!).sort()).toEqual(['keywords', 'name', 'path'])
    // Whether a project develops in a work tree is discovered from the directory, so no repository field is accepted.
    expect(SettingsSchema.safeParse({ projects: { items: [{ name: 'A', path: 'D:\\a', repo: 'web' }] } }).success).toBe(false)
  })
})

describe('projectsSection', () => {
  it('lists each project as its name, directory and keywords', () => {
    const text = projectsSection(settings({}, { items: PROJECTS }))
    expect(text).toContain('## Local projects')
    expect(text).toContain('- Demo Web; directory: D:\\work\\demo-web; keywords: landing page, 官网')
    expect(text).toContain('- DSH SuperAgent; directory: D:\\work\\dsh-superagent')
  })

  it('omits the keywords clause for a project that lists none', () => {
    const text = projectsSection(settings({}, { items: [{ name: 'Demo', path: 'D:\\work\\demo', keywords: [] }] }))
    expect(text).toContain('- Demo; directory: D:\\work\\demo')
    // Only the per-project lines may carry a keywords clause; the instruction above them says what missing keywords mean.
    expect(text.split('\n').filter(line => line.startsWith('- '))).toEqual(['- Demo; directory: D:\\work\\demo'])
  })

  it('tells the assessor that the name must go in the project field, not in the note', () => {
    const text = projectsSection(settings({}, { items: PROJECTS }))
    expect(text).toContain('set the assessment `project` field to the exact')
    expect(text).toContain('naming the project only in `note`')
  })

  it('is empty when no project is configured', () => {
    expect(projectsSection(settings())).toBe('')
  })
})

describe('DSH_SUPERAGENT_PROJECT variable', () => {
  const sources = { environments: () => [], declarations: () => [] } as unknown as SourceRegistry
  const deployment = {} as Deployment
  it('carries the project name when one matched, empty otherwise', () => {
    const matched = environmentOf({ deployment, sources, settings: settings({}, { items: PROJECTS }), ticket: { id: 't', name: 'n', directory: 'D:\\work\\demo-web', project: 'Demo Web' } })
    expect(matched.find(v => v.key === 'DSH_SUPERAGENT_PROJECT')?.value).toBe('Demo Web')
    const none = environmentOf({ deployment, sources, settings: settings(), ticket: { id: 't', name: 'n', directory: 'D:\\work\\x' } })
    expect(none.find(v => v.key === 'DSH_SUPERAGENT_PROJECT')?.value).toBe('')
  })
  it('carries the project directory, so a work tree ticket can read the rest of the project', () => {
    const routed = (project?: string): Ticket => ({ ...ticket(), execution: { name: 'n', directory: 'D:\\state\\work\\n', assignment: 'a',
      ...project ? { project } : {} } })
    const variables = ticketEnvironment({ deployment, sources, settings: settings({}, { items: PROJECTS }), ticket: routed('Demo Web') })
    expect(variables.find(v => v.key === 'DSH_SUPERAGENT_PROJECT_DIR')?.value).toBe('D:\\work\\demo-web')
    // A project removed from the registry leaves the directory empty rather than failing the environment.
    const gone = ticketEnvironment({ deployment, sources, settings: settings(), ticket: routed('Demo Web') })
    expect(gone.find(v => v.key === 'DSH_SUPERAGENT_PROJECT_DIR')?.value).toBe('')
  })
})

describe('project serialisation (one ticket per project at a time)', () => {
  const t = (id: string, project?: string) => ({ id, ...(project ? { execution: { name: 'n', directory: 'd', assignment: 'a', project } } : {}) }) as Ticket
  const none = new Map<string, string>()
  it('lets a ticket through when no other ticket of its project is launching or running', () => {
    expect(projectOccupied('demo-web', 't1', none, [t('t1', 'demo-web'), t('t2', 'other')], () => true)).toBe(false)
    // A ticket that only sees itself (regardless of its own running state) is not blocked by itself.
    expect(projectOccupied('demo-web', 't1', none, [t('t1', 'demo-web')], () => true)).toBe(false)
  })
  it('waits while another ticket of the same project is running', () => {
    expect(projectOccupied('demo-web', 't2', none, [t('t1', 'demo-web'), t('t2', 'demo-web')], ticket => ticket.id === 't1')).toBe(true)
    // A running ticket in a different project does not block this one.
    expect(projectOccupied('demo-web', 't2', none, [t('t1', 'other'), t('t2', 'demo-web')], () => true)).toBe(false)
  })
  it('waits while another ticket of the same project is mid-launch', () => {
    expect(projectOccupied('demo-web', 't2', new Map([['demo-web', 't1']]), [t('t2', 'demo-web')], () => false)).toBe(true)
    // Its own launch reservation does not block it.
    expect(projectOccupied('demo-web', 't1', new Map([['demo-web', 't1']]), [t('t1', 'demo-web')], () => false)).toBe(false)
  })
  it('never blocks a ticket with no project', () => {
    expect(projectOccupied('', 't2', none, [t('t1', 'demo-web')], () => true)).toBe(false)
  })
})
