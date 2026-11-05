/** Execution status view (active Tickets and pause control) and Execution settings group (Executor capacity and workspace environment). */
import { useRef, useState } from 'react'
import { TICKET_FILTERS, type TicketFilter } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import { usePoll, type SettingsView, type SourceView, type StateView } from './api.ts'
import { DisclosureRow, Icon, InfoTip, Input, Pill, SegmentedControl, Switch } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { ConfigHistory, Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadMore, LoadState, Section, StatusHead } from './widgets.tsx'

export function ExecutionStatus({ filter: current, state, reload }: {
  filter: TicketFilter; state: StateView; reload: () => Promise<void>
}) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error, reload: reloadTickets } = usePoll(() => call('GET tickets', { query: { state: current, limit } }), [current, limit])
  const { paused, load: { maxWorkers } } = state
  // Pausing uses its own block revision so toggling pause does not invalidate an open Execution settings draft.
  const pause = async () => { await call('POST executor/pause', { body: { paused: !paused } }); await reload() }
  const status = state.setup.problem ? { tone: 'warning', label: t('executorWaitingSetup') } : paused ? { tone: 'warning',
    label: t('processingPaused') }
    : { tone: 'ongoing', label: t('executorRunning') }
  const action = paused ? 'resumeProcessing' : 'pauseProcessing'
  return <>
    <StatusHead hint={t('executionStatusIntro')} settings="execution" />
    <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state={status.tone}>{status.label}</span>
      {!state.setup.problem && <>
        <LabelValue label={t('executingLabel')}
          value={`${state.load.running} / ${maxWorkers}`} /><LabelValue label={t('queuedLabel')} value={state.load.queued} />
      </>}
      <ConfirmButton variant="outline" icon={paused ? 'play' : 'pause'} label={t(action)} title={t(action)} message={t(paused
        ? 'resumeProcessingConfirm' : 'pauseProcessingConfirm')}
        onConfirm={pause} />
    </div>
    <div className="dt-filters">
      {TICKET_FILTERS.map(value => <Pill key={value} active={current === value}
        onClick={() => { setLimit(20); navigate({ page: 'execution', query: value === 'open' ? {} : { filter: value } },
          true) }}>{t(`ticketFilter.${value}`)}</Pill>)}
    </div>
    {current === 'idle' && <Hint>{t('idleHint')}</Hint>}
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(ticket => ticket.stage === 'person'
      ? <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reloadTickets} /> : <TicketLine key={ticket.id} ticket={ticket} />)}</ul> : <Hint>{t('none')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </>
}

const firstSentence = (text: string): string => /^[^。；;.]*(?:[。；;]|\.(?=\s|$))?/.exec(text)?.[0] ?? text
function EnvironmentVariables({ groups, sources,
  onPick }: { groups: SettingsView['environment']['variables']; sources: SourceView[]; onPick: (key: string) => void }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const owner = (id: string) => id === 'executor' ? t('term.executor') : localized(t, sources.find(source => source.id === id)?.title ?? id)
  const count = groups.reduce((sum, group) => sum + group.variables.length, 0)
  return <DisclosureRow icon={<Icon name="hash" />} title={<>{t('environmentVariables')} <span className="dt-count">{count}</span></>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('environmentPick')}</Hint>
      <table className="dt-table">
        <thead><tr><th>{t('environmentKey')}</th><th>{t('environmentDescription')}</th><th>{t('environmentOwner')}</th></tr></thead>
        <tbody>{groups.flatMap(group => group.variables.map(variable => <tr key={variable.key}>
          <td><button type="button" className="dt-textlink dt-mono" onClick={() => onPick(variable.key)}>{variable.key}</button></td>
          <td title={localized(t, variable.description)}>{firstSentence(localized(t, variable.description))}</td>
          <td>{owner(group.owner)}{!group.enabled && <span className="dt-hint"> · {t('sourceOff')}</span>}</td>
        </tr>))}</tbody>
      </table>
    </div>
  </DisclosureRow>
}
/** One editable project row: fields are kept as raw text in the draft and parsed on save. */
interface ProjectDraft { id: string; name: string; path: string; keywords: string; description: string; prepare: string; enabled: boolean }
const emptyProject = (): ProjectDraft => ({ id: '', name: '', path: '', keywords: '', description: '', prepare: '', enabled: true })
/** Turn a display name into a lowercase kebab-case id, used when the operator leaves the id blank. */
const idFromName = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
/**
 * The local project registry editor: add, edit, enable or remove projects an assessment may route a ticket to. Each project's
 * `path` becomes a worker's workspace, so it is the operator's decision which directories are listed here.
 */
function ProjectsEditor({ projects, onChange }: { projects: ProjectDraft[]; onChange: (next: ProjectDraft[]) => void }) {
  const { t } = usePanel()
  const set = (index: number, patch: Partial<ProjectDraft>) => onChange(projects.map((project, i) => i === index ? { ...project, ...patch } : project))
  return <div className="dt-projects">
    {projects.length === 0 ? <Hint>{t('projectsNone')}</Hint> : <ul className="dt-list">
      {projects.map((project, index) => <li key={index} className="dt-project-row">
        <div className="dt-grid3">
          <Field label={t('projectName')}><Input value={project.name}
            onChange={event => set(index, { name: event.target.value, ...project.id ? {} : { id: idFromName(event.target.value) } })} /></Field>
          <Field label={t('projectId')}><Input className="dt-mono" value={project.id} spellCheck={false}
            onChange={event => set(index, { id: event.target.value.trim().toLowerCase() })} /></Field>
          <Field label={t('projectEnabled')}><Switch checked={project.enabled} label={t('projectEnabled')}
            onChange={next => set(index, { enabled: next })} /></Field>
        </div>
        <Field label={t('projectPath')} hint={t('projectPathHint')}><Input className="dt-mono" value={project.path} spellCheck={false}
          placeholder={t('projectPathEmpty')} onChange={event => set(index, { path: event.target.value })} /></Field>
        <Field label={t('projectKeywords')} hint={t('projectKeywordsHint')}><Input value={project.keywords}
          placeholder={t('projectKeywordsEmpty')} onChange={event => set(index, { keywords: event.target.value })} /></Field>
        <Field label={t('projectDescription')} hint={t('projectDescriptionHint')}><Input value={project.description}
          onChange={event => set(index, { description: event.target.value })} /></Field>
        <Field label={t('projectPrepare')} hint={t('projectPrepareHint')}><Input className="dt-mono" value={project.prepare}
          spellCheck={false} placeholder={t('projectPrepareEmpty')} onChange={event => set(index, { prepare: event.target.value })} /></Field>
        <button type="button" className="dt-textlink" onClick={() => onChange(projects.filter((_, i) => i !== index))}>
          <Icon name="trash" size={14} /> {t('projectRemove')}
        </button>
      </li>)}
    </ul>}
    <button type="button" className="dt-textlink" onClick={() => onChange([...projects, emptyProject()])}>
      <Icon name="plus" size={14} /> {t('projectAdd')}
    </button>
  </div>
}
export function ExecutionSettings() {
  const { t } = usePanel()
  const { blocks, environment, sources } = useSettings().settings
  // Keep raw user text (such as separators between blocked commands) in the draft and parse only on save.
  const executor = blocks.executor.value
  const saved = { ...executor, maxWorkers: String(executor.maxWorkers), blockedCommands: executor.blockedCommands.join(' '),
    projects: executor.projects.map(({ id, name, path, keywords, description, prepare, enabled }): ProjectDraft =>
      ({ id, name, path, keywords: keywords.join(', '), description, prepare, enabled })) }
  const draft = useBlockDraft('executor', saved, blocks.executor.revision, value => ({ ...value,
    maxWorkers: numberOf(value.maxWorkers), blockedCommands: value.blockedCommands.split(/[\s,]+/).filter(Boolean),
    projects: value.projects.map(({ id, name, path, keywords, description, prepare, enabled }) => ({ id: id.trim(), name: name.trim(), path: path.trim(),
      keywords: keywords.split(/[,，\s]+/).map(word => word.trim()).filter(Boolean), description: description.trim(), prepare: prepare.trim(), enabled })) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const prepare = useRef<HTMLTextAreaElement>(null)
  const insert = (key: string) => {
    const field = prepare.current
    const at = field?.selectionStart ?? value.prepare.length, to = field?.selectionEnd ?? at
    edit({ prepare: `${value.prepare.slice(0, at)}"$${key}"${value.prepare.slice(to)}` })
    requestAnimationFrame(() => { field?.focus(); const caret = at + key.length + 3; field?.setSelectionRange(caret, caret) })
  }
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.executor')}<InfoTip text={t('executorIntro')} /></h2>
          <Section title={t('executorModel')} hint={t('executorModelHint')}><ModelField id="dt-worker-model" value={value.model}
            onChange={model => edit({ model })} /></Section>
          <Field label={t('maxWorkers')} hint={t('maxWorkersHint')}>
            <Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={value.maxWorkers}
              onChange={event => edit({ maxWorkers: event.target.value })} />
          </Field>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.environment')}<InfoTip text={t('environmentIntro')} /></h2>
          <Field label={t('executionDirectory')} hint={t('executionDirectoryHint')} note={value.directory ? undefined
            : t('executionDirectoryDefault', { root: environment.root })}>
            <Input className="dt-mono" value={value.directory} placeholder={t('executionDirectoryEmpty')} spellCheck={false} pattern="/.*"
              onChange={event => edit({ directory: event.target.value })} />
          </Field>
          <Section title={t('projectsTitle')} hint={t('projectsIntro')}>
            <ProjectsEditor projects={value.projects} onChange={projects => edit({ projects })} />
            <Field label={t('matchFallback')} hint={t('matchFallbackHint')}>
              <SegmentedControl label={t('matchFallback')} value={value.matchFallback}
                options={[{ value: 'directory' as const, label: t('matchFallbackDirectory') },
                  { value: 'stop' as const, label: t('matchFallbackStop') }]}
                onChange={next => edit({ matchFallback: next })} />
            </Field>
          </Section>
          <Field label={t('prepareCommand')} hint={t('prepareCommandHint')}>
            <textarea ref={prepare} className="dt-textarea dt-mono" rows={3} maxLength={LIMITS.prepareCommand} spellCheck={false}
              placeholder={t('prepareCommandEmpty')} value={value.prepare}
              onChange={event => edit({ prepare: event.target.value })} />
          </Field>
          <EnvironmentVariables groups={environment.variables} sources={sources} onPick={insert} />
          <Field label={t('blockedCommands')} hint={t('blockedCommandsHint')}>
            <Input className="dt-mono" value={value.blockedCommands} placeholder={t('blockedCommandsNone')} spellCheck={false}
              onChange={event => edit({ blockedCommands: event.target.value })} />
          </Field>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['executor', 'pause']} />
  </div>
}
