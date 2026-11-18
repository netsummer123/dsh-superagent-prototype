/**
 * Person notifications: a background loop that scans Tickets and pushes one DingTalk robot message when either
 *  (a) a Ticket enters a stage that waits on a person (review, answer, delivery, blocked or failed) — a decision push, or
 *  (b) a Ticket finishes — a result push.
 * Both carry the ticket's key points (outcome, PR/branch, the latest summary or open question) rather than a bare "someone
 * needs you". Deduplicated through KV so each need/result is announced once and never repeats per tick or restart.
 */
import type { Ticket, TicketOutcome } from '../core/index.ts'
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
/** How a finished ticket ended, in the words the result push uses. */
const OUTCOME_HINT: Record<TicketOutcome, string> = {
  completed: '已完成',
  merged: '已完成并合并',
  closed: 'PR 已关闭（未合并）',
  dropped: '已放弃（无事可做）',
  stopped: '已被人工停止',
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

/** The latest report a worker filed on the ticket, if any. */
function latestReport(ticket: Ticket): { state: string; summary: string } | undefined {
  return ticket.assignments.findLast(a => a.report)?.report
}

/** The PR/thread the ticket follows (its pull request), if the Source recorded one. */
function prRef(ticket: Ticket): string | undefined {
  const follow = ticket.follows?.find(item => item.own) ?? ticket.follows?.[0]
  if (!follow) return undefined
  const thread = follow.thread
  // A thread is a Source-specific PR reference; keep the trailing number or the whole ref, whichever reads best.
  return thread
}

/**
 * The key points of a ticket, one `label：value` line each: what happened (outcome or action), the PR/branch, and the latest
 * summary or the open question. Shared by the decision and result pushes so both tell the operator what matters.
 */
export function keyPoints(ticket: Ticket, opts: { kind: 'decision'; action: PersonAction } | { kind: 'result' }): string[] {
  const lines: string[] = []
  if (opts.kind === 'result') {
    const outcome = ticket.ended?.outcome
    lines.push(`结果：${outcome ? OUTCOME_HINT[outcome] : '已结束'}`)
    if (ticket.ended?.reason) lines.push(`说明：${ticket.ended.reason.slice(0, SUMMARY_MAX)}`)
  } else {
    lines.push(`需要你：${ACTION_HINT[opts.action]}`)
    const question = ticket.attention?.question
    if (question) lines.push(`问题：${question.slice(0, SUMMARY_MAX)}`)
    if (ticket.delivery?.error) lines.push(`投递错误：${ticket.delivery.error.slice(0, SUMMARY_MAX)}`)
  }
  lines.push(`工单：${ticket.title}`)
  const pr = prRef(ticket)
  if (pr) lines.push(`PR/分支：${pr}`)
  if (ticket.execution?.name) lines.push(`执行名：${ticket.execution.name}`)
  const report = latestReport(ticket)
  if (report?.summary) lines.push(`摘要：${report.summary.slice(0, SUMMARY_MAX)}`)
  return lines
}

/**
 * Runs the person-notification loop until `signal` aborts. Each pass reads every ticket and pushes:
 *  - one decision message per `person`-stage ticket whose (id, action) is not yet announced, and
 *  - one result message per ended ticket whose id is not yet announced.
 * Deduplicated through two KV maps (person needs pruned to live needs; ended results bounded to the most recent).
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
    const robotCode = bot.robotCode || bot.appKey
    let failedThisPass = false
    // 1) Decision pushes: tickets waiting on a person, deduped by (id, action).
    if (await this.scanDecisions(robotCode, recipients, signal)) failedThisPass = true
    // 2) Result pushes: tickets that finished, deduped by id.
    if (await this.scanResults(robotCode, recipients, signal)) failedThisPass = true
    // Only report the slot healthy after a pass with no failed send: a giving-up error must stay visible.
    if (!failedThisPass) this.host.ok?.()
  }

  /** Send one message per new person-stage need; returns true if any send failed this pass. */
  private async scanDecisions(robotCode: string, recipients: string[], signal: AbortSignal): Promise<boolean> {
    const announced = this.host.store.get(KV.personNotify.notified) ?? {}
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
    for (const key of this.failures.keys()) if (!live.has(key)) this.failures.delete(key)
    let failedThisPass = false
    for (const item of pending) {
      if (signal.aborted) break
      const failed = this.failures.get(item.key) ?? 0
      if (failed >= MAX_SEND_FAILURES) {
        // This need was abandoned after the failure cap, but it is still unannounced and live: keep the slot in `error` so the
        // health board does not read healthy while a person is never told. It retries once the need (ticket/action) changes.
        failedThisPass = true
        continue
      }
      try {
        await this.send(robotCode, recipients, this.compose(item.ticket, { kind: 'decision', action: item.action }))
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
    const changed = Object.keys(next).length !== Object.keys(announced).length
      || Object.keys(next).some(key => next[key] !== announced[key])
    if (changed) this.host.store.set(KV.personNotify.notified, next)
    return failedThisPass
  }

  /** Send one message per newly ended ticket; returns true if any send failed this pass. */
  private async scanResults(robotCode: string, recipients: string[], signal: AbortSignal): Promise<boolean> {
    const announced = this.host.store.get(KV.personNotify.ended) ?? {}
    const next: Record<string, string> = { ...announced }
    const tickets = this.host.store.tickets.list()
    // Dedup is keyed `id:endedAt`, so a ticket that a resume ends again (a new `ended.at`) is announced exactly once. A failed
    // send is never recorded, so it retries next pass; and an announced entry is only dropped once its ticket leaves the store, so
    // nothing is ever re-sent just because the map was trimmed. There is therefore no count cap to resurrect old ids (the storm).
    // On the first run after this feature ships, the store already holds every historical ended ticket; seed them as announced
    // WITHOUT sending so the operator is not flooded with the whole backlog in one tick. The marker records that seeding happened.
    if (!this.host.store.get(KV.personNotify.endedWatermark)) {
      const seeded: Record<string, string> = { ...next }
      const at = new Date().toISOString()
      for (const ticket of tickets) if (ticket.ended) seeded[`${ticket.id}|${ticket.ended.at ?? ''}`] = at
      this.host.store.set(KV.personNotify.ended, seeded)
      this.host.store.set(KV.personNotify.endedWatermark, 'seeded')
      return false
    }
    let failedThisPass = false
    for (const ticket of tickets) {
      if (signal.aborted) break
      if (!ticket.ended) continue
      const key = `${ticket.id}|${ticket.ended.at ?? ''}`
      if (announced[key]) continue
      try {
        await this.send(robotCode, recipients, this.compose(ticket, { kind: 'result' }))
      } catch (error) {
        failedThisPass = true
        // Results are terminal: retry next pass (no per-key failure cap needed), but do not record on failure.
        const detail = `person-notify: send result ${ticket.id}: ${error instanceof Error ? error.message : String(error)}`
        this.host.report(detail)
        continue
      }
      next[key] = new Date().toISOString()
    }
    // Liveness prune: drop entries whose ticket is gone from the store, so the map stays bounded by the store's own ticket set
    // without a count cap that could later re-expose a still-present id.
    const live = new Set(tickets.map(ticket => ticket.id))
    const pruned: Record<string, string> = {}
    for (const [key, when] of Object.entries(next)) {
      const id = key.slice(0, key.indexOf('|'))
      if (live.has(id)) pruned[key] = when
    }
    const changed = Object.keys(pruned).length !== Object.keys(announced).length
      || Object.keys(pruned).some(key => pruned[key] !== announced[key])
    if (changed) this.host.store.set(KV.personNotify.ended, pruned)
    return failedThisPass
  }

  /** Build the DingTalk `sampleText` body for a ticket: a headline plus its key points and the panel link. */
  private compose(ticket: Ticket, kind: { kind: 'decision'; action: PersonAction } | { kind: 'result' }): string {
    const app = this.host.appName?.() ?? DEFAULT_APP_NAME
    const panel = this.host.panelUrl?.()
    const head = kind.kind === 'result' ? '有一条工单已出结果' : '有工单需要你处理'
    const points = keyPoints(ticket, kind)
    return [
      `【${app}】${head}`,
      ...points.map(line => `· ${line}`),
      panel ? `请在面板「${app} → 概览」查看：${panel}` : '',
    ].filter(Boolean).join('\n')
  }

  private async send(robotCode: string, userIds: string[], content: string): Promise<void> {
    await this.host.commands.dingtalk('/v1.0/robot/oToMessages/batchSend', {
      robotCode, userIds, msgKey: 'sampleText', msgParam: JSON.stringify({ content }),
    })
  }
}
