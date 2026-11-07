/** Quality-gate settings group: the host-run AI review ahead of a `ready` report, plus its own LLM endpoint. */
import { LIMITS } from '../limits.ts'
import { InfoTip, Input, SegmentedControl, Switch } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { Field, Fields, useBlockDraft, useSettings } from './settings-kit.tsx'
import { usePanel } from './provider.tsx'
import { Section } from './widgets.tsx'

/** Render the quality-gate block form; the token is a secret the panel never re-displays, so an empty value keeps the stored one. */
export function QualityGateSettings() {
  const { t } = usePanel()
  const { blocks } = useSettings().settings
  const saved = blocks.qualityGate.value
  const draft = useBlockDraft('qualityGate', saved, blocks.qualityGate.revision)
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const editLlm = (next: Partial<typeof value.llm>) => edit({ llm: { ...value.llm, ...next } })
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('qualityGateTitle')}<InfoTip text={t('qualityGateIntro')} /></h2>
          <Section title={t('qualityGateMode')} hint={t('qualityGateModeHint')}>
            <SegmentedControl label={t('qualityGateMode')} value={value.mode} onChange={mode => edit({ mode })}
              options={[{ value: 'off', label: t('qualityGateModeOff') }, { value: 'observe', label: t('qualityGateModeObserve') },
                { value: 'enforce', label: t('qualityGateModeEnforce') }]} />
          </Section>
          <Field label={t('qualityGateOnUnavailable')} hint={t('qualityGateOnUnavailableHint')}>
            <SegmentedControl label={t('qualityGateOnUnavailable')} value={value.onUnavailable}
              onChange={onUnavailable => edit({ onUnavailable })}
              options={[{ value: 'block', label: t('qualityGateOnUnavailableBlock') },
                { value: 'pass', label: t('qualityGateOnUnavailablePass') }]} />
          </Field>
          <Field label={t('qualityGateSeverity')} hint={t('qualityGateSeverityHint')}>
            <SegmentedControl label={t('qualityGateSeverity')} value={value.onSeverity} onChange={onSeverity => edit({ onSeverity })}
              options={[{ value: 'critical', label: t('qualityGateSeverityCritical') },
                { value: 'high', label: t('qualityGateSeverityHigh') }, { value: 'medium', label: t('qualityGateSeverityMedium') }]} />
          </Field>
          <Field label={t('qualityGateEffort')} hint={t('qualityGateEffortHint')}>
            <SegmentedControl label={t('qualityGateEffort')} value={value.effort} onChange={effort => edit({ effort })}
              options={[{ value: 'low', label: t('qualityGateEffortLow') }, { value: 'medium', label: t('qualityGateEffortMedium') },
                { value: 'high', label: t('qualityGateEffortHigh') }]} />
          </Field>
          <div className="dt-switch-row">
            <div className="dt-field-head">{t('qualityGateDeterministic')}<InfoTip text={t('qualityGateDeterministicHint')} /></div>
            <Switch checked={value.provider === 'deterministic'} label={t('qualityGateDeterministic')}
              onChange={on => edit({ provider: on ? 'deterministic' : 'ocr' })} />
          </div>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('qualityGateReviewer')}<InfoTip text={t('qualityGateReviewerHint')} /></h2>
          <Field label={t('qualityGateLlmUrl')} hint={t('qualityGateLlmUrlHint')}>
            <Input className="dt-mono" spellCheck={false} placeholder="https://gw.example.com/v1" value={value.llm.url}
              onChange={event => editLlm({ url: event.target.value })} />
          </Field>
          <Field label={t('qualityGateLlmModel')} hint={t('qualityGateLlmModelHint')}>
            <Input className="dt-mono" spellCheck={false} placeholder="qwen3.8-max" value={value.llm.model}
              onChange={event => editLlm({ model: event.target.value })} />
          </Field>
          <Field label={t('qualityGateLlmProtocol')} hint={t('qualityGateLlmProtocolHint')}>
            <SegmentedControl label={t('qualityGateLlmProtocol')} value={value.llm.protocol}
              onChange={protocol => editLlm({ protocol })}
              options={[{ value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }]} />
          </Field>
          <Field label={t('qualityGateLlmToken')} hint={t('qualityGateLlmTokenHint')}>
            <Input type="password" className="dt-mono" spellCheck={false} autoComplete="off" placeholder={t('qualityGateLlmTokenEmpty')}
              value={value.llm.token} onChange={event => editLlm({ token: event.target.value })} />
          </Field>
          <Field label={t('qualityGateMaxTokens')} hint={t('qualityGateMaxTokensHint')}>
            <Input type="number" min={0} value={String(value.maxTokensBudget)}
              onChange={event => edit({ maxTokensBudget: Number(event.target.value) })} />
          </Field>
          <Field label={t('qualityGateTimeout')} hint={t('qualityGateTimeoutHint')}>
            <Input type="number" min={1} max={30} value={String(value.timeoutMinutes)}
              onChange={event => edit({ timeoutMinutes: Number(event.target.value) })} />
          </Field>
          <Field label={t('qualityGateCoverage')} hint={t('qualityGateCoverageHint')}>
            <Input type="number" min={0} max={1} step={0.05} value={String(value.minCoverage)}
              onChange={event => edit({ minCoverage: Number(event.target.value) })} />
          </Field>
          <Field label={t('qualityGateAttempts')} hint={t('qualityGateAttemptsHint')}>
            <Input type="number" min={1} max={5} value={String(value.maxAttempts)}
              onChange={event => edit({ maxAttempts: Number(event.target.value) })} />
          </Field>
          <Field label={t('qualityGateOcrVersion')} hint={t('qualityGateOcrVersionHint')}>
            <Input className="dt-mono" spellCheck={false} value={value.ocrVersion}
              onChange={event => edit({ ocrVersion: event.target.value })} />
          </Field>
          <Field label={t('qualityGateProjects')} hint={t('qualityGateProjectsHint')} note={t('qualityGateProjectsNote', { max: LIMITS.projectName })}>
            <Input className="dt-mono" spellCheck={false} placeholder={t('qualityGateProjectsEmpty')}
              value={value.projects.join(', ')}
              onChange={event => edit({ projects: event.target.value.split(/[\s,]+/).filter(Boolean) })} />
          </Field>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
  </div>
}
