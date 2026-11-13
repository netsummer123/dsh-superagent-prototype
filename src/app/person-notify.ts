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
}

/**
 * Runs the person-notification loop until `signal` aborts. Each pass reads every live ticket, computes its stage, and for
 * each `person`-stage ticket whose (id, action) is not yet announced, sends one DingTalk message to every allowed operator
 * and records the key. Records are pruned to live needs so the map stays bounded.
 */
export class PersonNotify {
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly host: PersonNotifyHost) {}

  start(signal: AbortSignal): void {
    const tick = async (): Promise<void> => {
      if (signal.aborted) return
      try { await this.scan() } catch (error) { this.host.report(`person-notify: ${error instanceof Error ? error.message : String(error)}`) }
      if (!signal.aborted) this.timer = setTimeout(() => void tick(), SCAN_MS)
    }
    void tick()
  }

  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined }

  private async scan(): Promise<void> {
    const bot = this.host.deployment()?.dingtalk
    if (!bot) return
    const recipients = (this.host.store.settings().policy.sources.dingtalk?.allowed ?? []).map(entry => entry.id).filter(Boolean)
    if (!recipients.length) return
    const announced = this.host.store.get(KV.runtime.personNotified) ?? {}
    const next: Record<string, string> = {}
    for (const ticket of this.host.store.tickets.list()) {
      if (ticket.ended) continue
      const stage = ticketStage(ticket)
      if (stage.stage !== 'person') continue
      const key = `${ticket.id}:${stage.action}`
      if (announced[key]) { next[key] = announced[key]!; continue }
      try {
        await this.send(bot.robotCode || bot.appKey, recipients, ticket, stage.action)
      } catch (error) {
        // One failed send must not stop the pass or re-announce earlier ones; record it and try this ticket next tick.
        this.host.report(`person-notify: send ${key}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      // Persist as soon as the message goes out, so a later failure cannot leave a delivered need unrecorded and repeated.
      next[key] = new Date().toISOString()
      this.host.store.set(KV.runtime.personNotified, next)
    }
    // Prune records whose need is gone so the map stays bounded, writing only when the set of live keys shrank.
    if (Object.keys(next).length !== Object.keys(announced).length) this.host.store.set(KV.runtime.personNotified, next)
  }

  private async send(robotCode: string, userIds: string[], ticket: Ticket, action: PersonAction): Promise<void> {
    // The latest report's own summary, when the worker wrote one, tells the person what happened.
    const report = [...ticket.assignments].reverse().find(a => a.report)?.report
    const summary = report?.summary ?? (ticket.attention as { text?: string } | undefined)?.text ?? ''
    const content = [
      `【super-agent】有工单需要你处理：${ACTION_HINT[action]}`,
      `工单：${ticket.title}`,
      summary ? `进度：${summary.slice(0, 300)}` : '',
      '请在面板「Superagent → 概览」查看：http://127.0.0.1:3082',
    ].filter(Boolean).join('\n')
    await this.host.commands.dingtalk('/v1.0/robot/oToMessages/batchSend', {
      robotCode, userIds, msgKey: 'sampleText', msgParam: JSON.stringify({ content }),
    })
  }
}
