/**
 * Person notifications: a background loop that scans Tickets and, when one enters a stage that waits on a person
 * (review, answer, delivery, blocked or failed), sends one DingTalk robot message per (ticket, action) so the operator
 * is told what needs a human. Deduplicated through KV so a need is announced once and never repeats each tick or restart.
 */
import type { Ticket } from '../core/index.ts'
import { ticketStage } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Commands } from '../infra/commands.ts'
import type { Deployment } from '../deployment.ts'
import type { Store } from './store.ts'

/** How often the loop scans tickets, in milliseconds. */
const SCAN_MS = 5_000
/** Consecutive failed sends of one ticket:action before the loop stops retrying it and reports it once on the health board. */
const MAX_SEND_FAILURES = 5
/** Fallback app name shown in the message head. */
const DEFAULT_APP_NAME = 'super-agent'
/** Truncation limit (characters) for a report summary inside the DingTalk text body. */
const SUMMARY_MAX = 300

type PersonAction = 'review' | 'answer' | 'delivery' | 'blocked' | 'failed'
/** What a person must do, in the words the DingTalk message uses. */
const ACTION_HINT: Record<PersonAction, string> = {
  review: '完成并已开 PR，等你验收/合并',
  answer: '遇到需要你回答的问题',
  delivery: '有一条回复投递失败，需要处理',
  blocked: '执行受阻，需要你处理',
  failed: '执行失败，需要你处理',
}

/** Dependencies the loop needs from the runtime; kept narrow so it stays a leaf module. */
export interface PersonNotifyHost {
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set'>
  readonly commands: Pick<Commands, 'dingtalk'>
  deployment(): Deployment | undefined
  /** Records an unexpected failure of the loop; the runtime decides where it surfaces. */
  report(message: string): void
  /** A pass finished with nothing wrong; the runtime clears any earlier error state. */
  ok?(): void
  /** URL of the panel a person opens, and the app name shown in the message head, when the deployment supplies them. */
  panelUrl?(): string | undefined
  appName?(): string | undefined
}

/**
 * Runs the person-notification loop until `signal` aborts. Each pass reads every live ticket, computes its stage, and for
 * each `person`-stage ticket whose (id, action) is not yet announced, sends one DingTalk message to every allowed operator
 * and records the key. Records are pruned to live needs so the map stays bounded.
 */
export class PersonNotify {
  private timer: ReturnType<typeof setTimeout> | undefined
  /** In-process consecutive failures per ticket:action, so a persistent send error backs off instead of hammering every tick. */
  private readonly failures = new Map<string, number>()
  constructor(private readonly host: PersonNotifyHost) {}

  start(signal: AbortSignal): void {
    const tick = async (): Promise<void> => {
      if (signal.aborted) return
      try { await this.scan(signal) } catch (error) { this.host.report(`person-notify: ${error instanceof Error ? error.message : String(error)}`) }
      if (!signal.aborted) this.timer = setTimeout(() => void tick(), SCAN_MS)
    }
    void tick()
  }

  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined }

  private async scan(signal: AbortSignal): Promise<void> {
    const bot = this.host.deployment()?.dingtalk
    if (!bot) { this.host.ok?.(); return }
    const recipients = (this.host.store.settings().policy.sources.dingtalk?.allowed ?? []).map(entry => entry.id).filter(Boolean)
    if (!recipients.length) { this.host.ok?.(); return }
    const announced = this.host.store.get(KV.personNotify.notified) ?? {}
    // Build the full next map from every live, person-stage ticket first: keep records already announced, and queue new
    // needs. Seeding from `announced` up front means the map is complete even if a send fails or the pass is cut short.
    const next: Record<string, string> = {}
    const pending: { key: string; ticket: Ticket; action: PersonAction }[] = []
    for (const ticket of this.host.store.tickets.list()) {
      if (ticket.ended) continue
      const stage = ticketStage(ticket)
      if (stage.stage !== 'person') continue
      const key = `${ticket.id}:${stage.action}`
      if (announced[key]) next[key] = announced[key]!
      else pending.push({ key, ticket, action: stage.action })
    }
    const live = new Set(pending.map(item => item.key))
    // Forget failure counts for needs that are gone, so a fresh need for the same ticket:action can be announced again.
    for (const key of this.failures.keys()) if (!live.has(key)) this.failures.delete(key)
    // Send each new need on its own: one failing send is reported and skipped (retried next pass) without silencing the rest
    // or re-announcing those already recorded. Stop between sends if the runtime is shutting down, but still persist the map.
    let failedThisPass = false
    for (const item of pending) {
      if (signal.aborted) break
      const failed = this.failures.get(item.key) ?? 0
      // A need past the cap is left for good until its count is pruned when the need is gone; do not resend it.
      if (failed >= MAX_SEND_FAILURES) continue
      try {
        await this.send(bot.robotCode || bot.appKey, recipients, item.ticket, item.action)
      } catch (error) {
        failedThisPass = true
        const count = failed + 1
        this.failures.set(item.key, count)
        const detail = `person-notify: send ${item.key} (attempt ${count}): ${error instanceof Error ? error.message : String(error)}`
        if (count >= MAX_SEND_FAILURES) this.host.report(`${detail} — giving up until the need changes`)
        continue
      }
      this.failures.delete(item.key)
      next[item.key] = new Date().toISOString()
    }
    // Persist the whole map once, comparing key/value sets (not text order), so an idle tick writes nothing.
    const changed = Object.keys(next).length !== Object.keys(announced).length
      || Object.keys(next).some(key => next[key] !== announced[key])
    if (changed) this.host.store.set(KV.personNotify.notified, next)
    // Only report the slot healthy after a pass with no failed send: a giving-up error set above must stay visible.
    if (!failedThisPass) this.host.ok?.()
  }

  private async send(robotCode: string, userIds: string[], ticket: Ticket, action: PersonAction): Promise<void> {
    // The latest report's own summary, or the open question, tells the person what happened.
    const report = ticket.assignments.findLast(a => a.report)?.report
    const summary = report?.summary ?? ticket.attention?.question ?? ''
    const app = this.host.appName?.() ?? DEFAULT_APP_NAME
    const panel = this.host.panelUrl?.()
    const content = [
      `【${app}】有工单需要你处理：${ACTION_HINT[action]}`,
      `工单：${ticket.title}`,
      summary ? `进度：${summary.slice(0, SUMMARY_MAX)}` : '',
      panel ? `请在面板「${app} → 概览」查看：${panel}` : '',
    ].filter(Boolean).join('\n')
    await this.host.commands.dingtalk('/v1.0/robot/oToMessages/batchSend', {
      robotCode, userIds, msgKey: 'sampleText', msgParam: JSON.stringify({ content }),
    })
  }
}
