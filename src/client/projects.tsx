/** The local project registry settings group: a list of projects an assessment may route a ticket to, and what happens without a match. */
import { Icon, InfoTip, Input, SegmentedControl } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { ConfigHistory, Field, Fields, useBlockDraft, useSettings } from './settings-kit.tsx'
import { SaveBar } from './draft.tsx'
import { Hint, Section } from './widgets.tsx'

/** One project row while it is being edited: keywords stay one raw string in the draft and are split on save. */
interface ProjectRow { name: string; path: string; keywords: string }
const EMPTY_ROW: ProjectRow = { name: '', path: '', keywords: '' }
/**
 * The local project registry: each project is one row of name, directory and optional keywords, and a row is removed by its delete
 * button rather than disabled. A project's directory becomes a worker's workspace, so which directories are listed here is the
 * operator's decision.
 */
export function ProjectSettings() {
  const { t } = usePanel()
  const { blocks } = useSettings().settings
  const saved = { items: blocks.projects.value.items.map(({ name, path, keywords }): ProjectRow =>
    ({ name, path, keywords: keywords.join(', ') })), matchFallback: blocks.projects.value.matchFallback }
  const draft = useBlockDraft('projects', saved, blocks.projects.revision, value => ({
    matchFallback: value.matchFallback,
    items: value.items.map(({ name, path, keywords }) => ({ name: name.trim(), path: path.trim(),
      keywords: keywords.split(/[,，\s]+/).map(word => word.trim()).filter(Boolean) })),
  }))
  const value = draft.value
  const rows = value.items
  const set = (index: number, patch: Partial<ProjectRow>) =>
    draft.edit({ ...value, items: rows.map((row, i) => i === index ? { ...row, ...patch } : row) })
  const remove = (index: number) => draft.edit({ ...value, items: rows.filter((_, i) => i !== index) })
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('projectsTitle')}<InfoTip text={t('projectsIntro')} /></h2>
          <Section title={t('projectsList')} hint={t('projectsListHint')}>
            {rows.length === 0 ? <Hint>{t('projectsNone')}</Hint> : <table className="dt-table dt-projects">
              <thead><tr><th>{t('projectName')}</th><th>{t('projectPath')}</th><th>{t('projectKeywords')}</th><th>{t('projectActions')}</th></tr></thead>
              <tbody>{rows.map((row, index) => <tr key={index}>
                <td><Input value={row.name} placeholder={t('projectNameEmpty')} maxLength={80}
                  onChange={event => set(index, { name: event.target.value })} /></td>
                <td><Input className="dt-mono" value={row.path} placeholder={t('projectPathEmpty')} spellCheck={false}
                  onChange={event => set(index, { path: event.target.value })} /></td>
                <td><Input value={row.keywords} placeholder={t('projectKeywordsEmpty')}
                  onChange={event => set(index, { keywords: event.target.value })} /></td>
                <td><button type="button" className="dt-textlink dt-danger-link dt-project-remove"
                  title={t('projectRemove')} aria-label={`${t('projectRemove')} ${row.name || index + 1}`} onClick={() => remove(index)}>
                  <Icon name="trash" size={18} /></button></td>
              </tr>)}</tbody>
            </table>}
            <button type="button" className="dt-textlink" onClick={() => draft.edit({ ...value, items: [...rows, { ...EMPTY_ROW }] })}>
              <Icon name="plus" size={14} /> {t('projectAdd')}
            </button>
          </Section>
          <Field label={t('matchFallback')} hint={t('matchFallbackHint')}>
            <SegmentedControl label={t('matchFallback')} value={value.matchFallback}
              options={[{ value: 'directory' as const, label: t('matchFallbackDirectory') },
                { value: 'stop' as const, label: t('matchFallbackStop') }]}
              onChange={next => draft.edit({ ...value, matchFallback: next })} />
          </Field>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['projects']} />
  </div>
}
