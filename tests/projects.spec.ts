import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { SettingsSchema } from '../src/policy.ts'
import { ticketExecution, projectOccupied } from '../src/executor/dsh.ts'
import { projectsSection } from '../src/app/prompts.ts'
import { environmentOf } from '../src/app/execution-environment.ts'
import type { AssessmentOutcome, Ticket } from '../src/core/index.ts'
import type { SourceRegistry } from '../src/sources/registry.ts'
import type { Deployment } from '../src/deployment.ts'

const STATE = 'D:\\state'

const settings = (executor: Record<string, unknown> = {}) => SettingsSchema.parse({ executor })

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
  { id: 'dsh-superagent', name: 'DSH SuperAgent', path: 'D:\\work\\dsh-superagent', keywords: ['superagent', 'agent'], description: 'platform repo' },
  { id: 'demo-web', name: 'Demo Web', path: 'D:\\work\\demo-web', keywords: ['landing page', '官网'], description: 'marketing site' },
]

describe('project routing in ticketExecution', () => {
  it('uses the matched project path as the workspace and records its id', () => {
    const execution = ticketExecution(ticket(), accept('fix-spacing', 'demo-web'), settings({ projects: PROJECTS }), STATE)
    expect(execution.directory).toBe('D:\\work\\demo-web')
    expect(execution.projectId).toBe('demo-web')
    expect(execution.name).toBe('fix-spacing-tkt-abcdef12')
  })

  it('falls back to the execution root when the assessment names no project', () => {
    const execution = ticketExecution(ticket(), accept('fix-spacing'), settings({ projects: PROJECTS }), STATE)
    expect(execution.directory).toBe(join(join(STATE, 'work'), 'fix-spacing-tkt-abcdef12'))
    expect(execution.projectId).toBeUndefined()
  })

  it('falls back when the named project id is unknown or disabled, never throwing', () => {
    const unknown = ticketExecution(ticket(), accept('fix-spacing', 'nope'), settings({ projects: PROJECTS }), STATE)
    expect(unknown.projectId).toBeUndefined()
    expect(unknown.directory).toBe(join(join(STATE, 'work'), 'fix-spacing-tkt-abcdef12'))
    const disabled = ticketExecution(ticket(), accept('fix-spacing', 'demo-web'), settings({ projects: [{ ...PROJECTS[1]!, enabled: false }] }), STATE)
    expect(disabled.projectId).toBeUndefined()
  })

  it('honours a configured ticket directory root when no project matches', () => {
    const execution = ticketExecution(ticket(), accept('fix-spacing'), settings({ directory: 'D:\\root', projects: PROJECTS }), STATE)
    expect(execution.directory).toBe(join('D:\\root', 'fix-spacing-tkt-abcdef12'))
  })
})

describe('projectsSection', () => {
  it('lists only enabled projects, one per line, with id, keywords and description', () => {
    const text = projectsSection(settings({ projects: [...PROJECTS, { ...PROJECTS[0]!, id: 'off', enabled: false }] }))
    expect(text).toContain('Demo Web (demo-web)')
    expect(text).toContain('keywords: landing page, 官网')
    expect(text).toContain('description: marketing site')
    expect(text).not.toContain('(off)')
  })

  it('is empty when no project is configured', () => {
    expect(projectsSection(settings())).toBe('')
  })
})

describe('DSH_SUPERAGENT_PROJECT variable', () => {
  const sources = { environments: () => [], declarations: () => [] } as unknown as SourceRegistry
  const deployment = {} as Deployment
  it('carries the project id when one matched, empty otherwise', () => {
    const matched = environmentOf({ deployment, sources, settings: settings({ projects: PROJECTS }), ticket: { id: 't', name: 'n', directory: 'D:\\work\\demo-web', projectId: 'demo-web' } })
    expect(matched.find(v => v.key === 'DSH_SUPERAGENT_PROJECT')?.value).toBe('demo-web')
    const none = environmentOf({ deployment, sources, settings: settings(), ticket: { id: 't', name: 'n', directory: 'D:\\work\\x' } })
    expect(none.find(v => v.key === 'DSH_SUPERAGENT_PROJECT')?.value).toBe('')
  })
})

describe('project serialisation (one ticket per project at a time)', () => {
  const t = (id: string, projectId?: string) => ({ id, ...(projectId ? { execution: { name: 'n', directory: 'd', assignment: 'a', projectId } } : {}) }) as Ticket
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
