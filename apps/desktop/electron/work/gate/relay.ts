import { createHash } from 'node:crypto'

import { workExpectedThreadId, type WorkSendArguments, WorkSendArgumentsSchema } from './contract'
import type { CallContext } from './gate'
import { handoffBudget, type HistoricalMessage, historyCost, renderHistory, selectHistory } from './handoff-helper.cjs'
import type { GateLedger } from './ledger'
import type { GateSessions, OwnerEventVerifier, T3Port, T3Reply } from './ports'

export interface RelaySelection {
  revision: number
  instanceId: string
  model: string
  projectId: string
  personaRevision: number
}
export interface RelayHistory {
  boundary?(input: { agentPrincipal: string; roomId: string }): Promise<string>
  read(input: {
    agentPrincipal: string
    roomId: string
    before: string
    after: string | null
    floor: string | null
  }): Promise<HistoricalMessage[] | { messages: HistoricalMessage[]; omittedMessages: number; omittedBytes: number; truncated: boolean }>
}
interface Binding {
  epoch: number
  floor: string | null
  threadId: string | null
  sessionId: string
  open: string | null
  accepted: string | null
  delivered: string | null
  selection: RelaySelection | null
  resetPending?: boolean
  queueSince?: number
  queueUntil?: number
}
interface Frozen {
  frozenCall?: Record<string, unknown>
  input: WorkSendArguments
  bindingKey: string
  kind: 'launch' | 'send'
  call: Record<string, unknown>
  selection: RelaySelection
  snapshot: {
    selected: string[]
    omittedBytes: number
    omitted: number
    omittedIds: string[]
    truncated?: boolean
    lower: string | null
    floor: string | null
    upper: string
    epoch: number
  }
  admission?: RelayAnswer
  answer?: RelayAnswer
  sendResult?: RelayAnswer
  closed?: boolean
  resultRun?: string
  hold?: string
}
export interface RelayAnswer {
  class?: string
  [key: string]: unknown
}
export interface RelayOptions {
  gateId(): { accountId: string; deviceServiceId: string; routeEpoch: number }
  consent(): Record<string, unknown>
  localSwitch(): boolean
  ledger: GateLedger
  t3: T3Port
  sessions: GateSessions
  owner: OwnerEventVerifier
  history?: RelayHistory
  selection?(principal: string): RelaySelection | undefined
  provision?(principal: string, threadId: string): Promise<{ projectId: string; personaRevision: number }>
  authority?(ctx: CallContext): boolean
  resetAuthority?(ctx: CallContext): boolean
  fence(ctx: CallContext): boolean
  modeLimit: string
  now(): number
  limit?(): { state: 'unknown' | 'available' | 'exhausted'; resetAt?: number }
}

/** Thin main-owned adapter. Never accepts prompt material or a T3 target from the caller. */
export class WorkRelay {
  private busy = new Set<string>()
  private requests = new Set<string>()
  constructor(private readonly o: RelayOptions) {}
  private scope(ctx: CallContext, room: string): string {
    const gate = this.o.gateId()

    return `relay:${gate.accountId}:${gate.deviceServiceId}:${ctx.principal}:${ctx.generation}:${room}`
  }
  private key(ctx: CallContext, room: string): string {
    const scope = this.scope(ctx, room)

    return this.o.ledger.meta(`${scope}:active`) ?? `${scope}:${this.o.sessions.agentSessionId(ctx.principal) ?? ''}`
  }
  private binding(key: string, sessionId: string): Binding {
    const raw = this.o.ledger.meta(key)

    return raw
      ? (JSON.parse(raw) as Binding)
      : {
          epoch: 0,
          floor: null,
          threadId: null,
          sessionId,
          open: null,
          accepted: null,
          delivered: null,
          selection: null
        }
  }
  private save(key: string, binding: Binding): void {
    this.o.ledger.setMeta(key, JSON.stringify(binding))
  }
  private frozen(ctx: CallContext, id: string): Frozen | undefined {
    const raw = this.o.ledger.receipt(ctx.principal, id)?.relayJson

    return raw ? (JSON.parse(raw) as Frozen) : undefined
  }
  private store(ctx: CallContext, id: string, frozen: Frozen): void {
    this.o.ledger.update(ctx.principal, id, { relay_json: JSON.stringify(frozen) })
  }
  private allowed(ctx: CallContext): boolean {
    return this.o.fence(ctx)
  }
  private operation(ctx: CallContext, id: string) {
    const f = this.frozen(ctx, id)!
    const row = this.o.ledger.receipt(ctx.principal, id)!

    return {
      requestId: id,
      eventId: f.input.event_id,
      roomId: f.input.room_id,
      resetEpoch: f.snapshot.epoch,
      phase: f.answer ? 'answered' : f.hold ? 'held' : row.runId ? 'running' : 'admitted',
      ...(f.hold ? { hold: f.hold } : {}),
      forwarded: row.forwarded,
      threadId: row.threadId,
      ...(row.runId ? { runId: row.runId } : {}),
      stopOwed: row.stopScope !== null && row.settled === null
    }
  }
  private wire(ctx: CallContext, id: string, a: RelayAnswer): RelayAnswer {
    const head = { gateId: this.o.gateId(), requestId: id }

    if (a.class === 'refused' || a.class === 'unavailable') {
      return { ...head, class: 'refused', receipt: a.receipt ?? 'refused', forwarded: false, reason: a.reason === 'plan_consent_off' ? 'consent_off' : a.reason === 'plan_switch_off' ? 'switch_off' : a.reason ?? 'unavailable' }
    }

    if (a.class === 'revoked') {
      return {
        ...head,
        class: 'revoked',
        receipt: 'revoked',
        stopConfirmed: Boolean(this.o.ledger.receipt(ctx.principal, id)?.settled)
      }
    }

    if (a.class === 'accepted') {
      return { ...head, class: 'accepted', receipt: 'sent', operation: this.operation(ctx, id) }
    }

    if (a.class === 'none') {
      return { ...head, class: 'none', receipt: 'none' }
    }

    if (a.class === 'ok') {
      const row = this.o.ledger.receipt(ctx.principal, id)!

      if (!a.text || a.status !== 'completed') {
        return {
          ...head,
          class: 'terminal',
          receipt:
            a.status === 'completed'
              ? 'empty'
              : a.status === 'interrupted' || a.status === 'cancelled'
                ? 'stopped'
                : 'failed',
          finishedAt: a.finishedAt ?? this.o.now(),
          stopConfirmed: a.status === 'interrupted' || a.status === 'cancelled'
        }
      }

      return {
        ...head,
        class: 'completed',
        receipt: 'answered',
        answer: {
          runId: row.runId,
          resultRunId: a.runId,
          itemId: a.itemId,
          text: a.text,
          sha256: createHash('sha256')
            .update(a.text as string)
            .digest('hex'),
          finishedAt: a.finishedAt
        }
      }
    }

    const f = this.frozen(ctx, id)

    if (a.class === 'ambiguous') {
      return {
        ...head,
        class: 'ambiguous',
        receipt: 'admitted',
        forwarded: a.forwarded ?? false,
        reason: a.reason ?? 'unknown'
      }
    }

    return f
      ? { ...head, class: 'pending', receipt: 'admitted', operation: this.operation(ctx, id) }
      : { ...head, class: 'ambiguous', receipt: 'admitted', forwarded: false, reason: 'admission_in_progress' }
  }
  async send(ctx: CallContext, raw: unknown): Promise<RelayAnswer> {
    const id = String((raw as WorkSendArguments)?.request_id ?? '')
    const retired = this.o.ledger.receipt(ctx.principal, id)

    if (retired?.state === 'refused' && !retired.relayJson) {
      if (!this.allowed(ctx)) {
        return this.wire(ctx, id, { class: 'revoked' })
      }

      return this.wire(ctx, id, { class: 'refused', reason: retired.reason })
    }

    const a = await this.sendRaw(ctx, raw)

    if (
      (a.class === 'refused' || a.class === 'unavailable') &&
      !this.o.ledger.receipt(ctx.principal, id) &&
      /^[A-Za-z0-9_-]{22,64}$/u.test(id)
    ) {
      this.o.ledger.refuse(ctx.principal, id, String(a.reason ?? 'unavailable'))
    }

    const f = this.frozen(ctx, id)

    if (f?.sendResult && a.class !== 'refused' && a.class !== 'revoked') {
      return f.sendResult
    }

    const result = this.wire(ctx, id, a)

    if (f && a.class !== 'refused' && a.class !== 'revoked') {
      f.sendResult = result
      this.store(ctx, id, f)
    }

    return result
  }
  async request(ctx: CallContext, id: string): Promise<RelayAnswer> {
    if (!this.allowed(ctx)) {
      return this.wire(ctx, id, { class: 'revoked' })
    }

    const f = this.frozen(ctx, id)

    if (
      f &&
      (this.o.ledger.receipt(ctx.principal, id)?.stopScope || this.binding(f.bindingKey, '').epoch !== f.snapshot.epoch)
    ) {
      return this.wire(ctx, id, { class: 'revoked' })
    }

    const row = this.o.ledger.receipt(ctx.principal, id)

    if (!f && row?.state === 'refused') {
      return this.wire(ctx, id, { class: 'refused', reason: row.reason })
    }

    return this.wire(ctx, id, f?.answer ?? f?.admission ?? { class: f ? 'pending' : 'none' })
  }
  async read(ctx: CallContext, id: string, timeoutMs = 0): Promise<RelayAnswer> {
    return this.wire(ctx, id, await this.readRaw(ctx, id, timeoutMs))
  }
  closeReceipt(ctx: CallContext, id: string): RelayAnswer {
    const head = { gateId: this.o.gateId(), requestId: id }

    if (!(this.o.authority?.(ctx) ?? this.allowed(ctx))) {
      return {
        ...head,
        class: 'revoked',
        receipt: 'revoked',
        stopConfirmed: Boolean(this.o.ledger.receipt(ctx.principal, id)?.settled)
      }
    }

    if (!this.frozen(ctx, id)) {
      return { ...head, class: 'refused', receipt: 'refused', forwarded: false, reason: 'not_owned' }
    }

    return this.close(ctx, id)
      ? { ...head, class: 'closed', receipt: 'closed' }
      : this.wire(ctx, id, { class: 'pending' })
  }
  private async sendRaw(ctx: CallContext, raw: unknown): Promise<RelayAnswer> {
    const parsed = WorkSendArgumentsSchema.safeParse(raw)

    if (!parsed.success) {
      return {
        class: 'refused',
        reason: parsed.error.issues.some(i => i.code === 'unrecognized_keys') ? 'unknown_field' : 'invalid_field'
      }
    }

    const args = parsed.data

    if (!this.allowed(ctx)) {
      if (!this.frozen(ctx, args.request_id)) {
        const consent = this.o.consent()

        if (consent.state !== 'on') {return { class: 'refused', reason: 'consent_off' }}

        if (!this.o.localSwitch()) {return { class: 'refused', reason: 'switch_off' }}
      }

      return { class: 'revoked' }
    }

    const prior = this.frozen(ctx, args.request_id)

    if (prior) {
      if (this.o.ledger.receipt(ctx.principal, args.request_id)?.stopScope) {
        return { class: 'revoked' }
      }

      if (this.binding(prior.bindingKey, '').epoch !== prior.snapshot.epoch) {
        return { class: 'revoked' }
      }

      if (JSON.stringify(prior.input) !== JSON.stringify(args)) {
        return { class: 'refused', reason: 'changed' }
      }

      // No current history/selection/cursor lookups. Uncertain dispatch is read-only forever.
      return (
        prior.admission ?? {
          class: 'pending',
          request_id: args.request_id,
          forwarded: this.o.ledger.receipt(ctx.principal, args.request_id)?.forwarded ?? false
        }
      )
    }

    const requestKey = `${ctx.principal}:${args.request_id}`

    if (this.requests.has(requestKey)) {
      return { class: 'ambiguous', reason: 'admission_in_progress', forwarded: false }
    }

    let key = this.key(ctx, args.room_id)
    const lock = this.scope(ctx, args.room_id)

    if (this.busy.has(lock)) {
      return { class: 'refused', reason: 'operation_open' }
    }

    this.busy.add(lock)
    this.requests.add(requestKey)
    let bindingBefore: Binding | undefined

    try {
      if (this.o.ledger.receipt(ctx.principal, args.request_id)) {
        return { class: 'refused', reason: 'changed' }
      }

      if (this.o.ledger.eventClaimed(args.event_id)) {
        return { class: 'refused', reason: 'event_already_used' }
      }

      const session = await this.o.sessions.agent(ctx.principal)

      if (!this.o.ledger.meta(key)) {key = `${this.scope(ctx, args.room_id)}:${session.sessionId}`}
      let binding = this.binding(key, session.sessionId)

      if (binding.sessionId !== session.sessionId) {
        if (!(await this.reset(ctx, args.room_id, args.event_id, true))) {
          return { class: 'refused', reason: 'session_stop_pending' }
        }

        binding = this.binding(key, session.sessionId)
        key = `${this.scope(ctx, args.room_id)}:${session.sessionId}`
        this.o.ledger.tx(() => {
          this.save(key, binding)
          this.o.ledger.setMeta(`${this.scope(ctx, args.room_id)}:active`, key)
        })
      }

      if (binding.open || binding.resetPending) {
        return { class: 'refused', reason: 'operation_open' }
      }


      let selection = this.o.selection?.(ctx.principal)

      if (!selection || selection.revision !== args.selection_rev || selection.instanceId !== 'codex') {
        return { class: 'refused', reason: 'selection_changed' }
      }

      if ((await this.o.t3.planProvider?.(session.token))?.status !== 'connected') {
        return { class: 'unavailable', reason: 'provider_not_ready' }
      }

      if (this.o.limit?.().state === 'exhausted') {
        return { class: 'refused', reason: 'plan_limit' }
      }

      const event = await this.o.owner.fetch({ agentPrincipal: ctx.principal, eventId: args.event_id })

      if (event.kind !== 'ok') {
        return {
          class: event.kind === 'invalid' ? 'refused' : 'unavailable',
          reason: event.kind === 'invalid' ? event.reason : 'owner_event_unverifiable'
        }
      }

      if (event.roomId !== args.room_id || event.encrypted !== false) {
        return { class: 'refused', reason: 'owner_event_wrong_room' }
      }

      const age = this.o.now() - event.originServerTs

      if ((age > 900_000 && !(binding.queueSince !== undefined && event.originServerTs >= binding.queueSince && event.originServerTs <= (binding.queueUntil ?? 0))) || age < -60_000) {
        return { class: 'refused', reason: age < 0 ? 'owner_event_future' : 'owner_event_too_old' }
      }

      if (!this.o.history) {
        return { class: 'unavailable', reason: 'history_unavailable' }
      }

      // A failed read is durably refused by send(), without a claim or dispatch.
      const acquired = await this.o.history.read({
        agentPrincipal: ctx.principal,
        roomId: args.room_id,
        before: args.event_id,
        after: binding.delivered,
        floor: binding.floor
      })

      const historyRows = Array.isArray(acquired) ? acquired : acquired.messages

      const messages = historyRows.filter(m => {
        const replyTo = (m as HistoricalMessage & { replyTo?: string }).replyTo

        return !(m.role === 'assistant' && replyTo && this.o.ledger.receipts(
          'principal = ? AND event_id = ? AND forwarded = 1 AND relay_json IS NOT NULL', ctx.principal, replyTo
        ).length)
      })

      const budget = handoffBudget({
        tokenCap: 16_000,
        userText: event.body,
        attachments: [],
        providerThread: { contextUsage: null },
        nativeContextEstimate: 0
      })

      const selected = selectHistory({ messages, budget, coverage: `Owner DM history, before the current request.${!Array.isArray(acquired) && acquired.truncated ? ' Older history omitted at paging budget; total unknown.' : ''}` })

      const history =
        selected.messages.length && historyCost(selected.messages, selected.context) <= budget
          ? renderHistory(selected.messages, selected.context)
          : ''

      const message = `${history ? history + '\n\n' : ''}Current owner request:\n${event.body}`

      // Native launch has a 120,000-character ceiling. Never truncate the current request.
      if (message.length > 120_000) {
        return { class: 'refused', reason: 'message_too_long' }
      }

      const threadId = binding.threadId ?? workExpectedThreadId(session.sessionId, args.request_id)
      const kind = binding.threadId ? 'send' : 'launch'

      if (kind === 'launch' && this.o.provision) {
        selection = { ...selection, ...await this.o.provision(ctx.principal, threadId) }
      } else if (binding.selection) {
        selection = { ...selection, projectId: binding.selection.projectId, personaRevision: binding.selection.personaRevision }
      }

      const call =
        kind === 'launch'
          ? {
              projectId: selection.projectId,
              workspaceStrategy: { type: 'root' },
              title: 'Assistant conversation',
              modelSelection: { instanceId: selection.instanceId, model: selection.model },
              message,
              clientRequestId: args.request_id
            }
          : { threadId, message, clientRequestId: args.request_id }

      if (kind === 'send' && !this.o.t3.send) {
        return { class: 'unavailable', reason: 'provider_not_ready' }
      }

      if (!(await this.o.t3.prepare(session.token))) {
        return { class: 'unavailable', reason: 'provider_not_ready' }
      }

      if (kind === 'send') {
        const read = await this.o.t3.read(session.token, threadId)

        if (
          read.kind !== 'found' ||
          read.activeRunId ||
          (read.raw.thread as { blockedOnThreadWait?: boolean })?.blockedOnThreadWait ||
          ((read.raw.thread as { pendingBackgroundTasks?: unknown[] })?.pendingBackgroundTasks?.length ?? 0) > 0 ||
          read.runs.some(r => ['running', 'queued', 'starting', 'preparing', 'waiting'].includes(r.status))
        ) {
          return { class: 'refused', reason: 'thread_busy' }
        }

        // Native configure owns provider switching and context handoff. It cannot run a message.
        if (binding.selection?.instanceId !== selection.instanceId || binding.selection?.model !== selection.model) {
          const configured = await this.o.t3.configure?.(session.token, threadId, {
            instanceId: selection.instanceId,
            model: selection.model
          })

          if (!configured || configured.transport !== 'ok' || configured.isError || configured.status !== 200) {
            return { class: 'unavailable', reason: 'provider_not_ready' }
          }
        }
      }

      if (!this.allowed(ctx) || this.o.sessions.agentSessionId(ctx.principal) !== session.sessionId) {
        return { class: 'revoked' }
      }

      if (this.o.selection?.(ctx.principal)?.revision !== args.selection_rev) {
        return { class: 'refused', reason: 'selection_changed' }
      }

      const frozen: Frozen = {
        input: args,
        bindingKey: key,
        kind,
        call,
        selection,
        snapshot: {
          truncated: !Array.isArray(acquired) && acquired.truncated,
          selected: selected.messages.map(m => m.itemId),
          omittedBytes: (Array.isArray(acquired) ? 0 : acquired.omittedBytes) + messages
            .filter(m => selected.omittedItemIds.includes(m.itemId))
            .reduce((n, m) => n + Buffer.byteLength(m.text), 0),
          omitted: selected.omittedItems + (Array.isArray(acquired) ? 0 : acquired.omittedMessages),
          omittedIds: selected.omittedItemIds,
          lower: binding.delivered,
          floor: binding.floor,
          upper: args.event_id,
          epoch: binding.epoch
        }
      }

      const gateId = this.o.gateId()
      frozen.frozenCall = {
        envelope: args,
        binding: {
          accountId: gateId.accountId,
          agentPrincipal: ctx.principal,
          roomId: args.room_id,
          deviceServiceId: gateId.deviceServiceId,
          routeEpoch: ctx.routeEpoch,
          agentGeneration: ctx.generation,
          t3SessionId: session.sessionId,
          threadId,
          reset: { epoch: binding.epoch, historyFloor: binding.floor },
          selection: { provider: 'atum-work', plan: 'codex', model: selection.model, revision: selection.revision },
          providerInstance: selection.instanceId,
          personaRevision: binding.selection?.personaRevision ?? selection.personaRevision,
          accepted: args.event_id,
          delivered: binding.delivered,
          openRequestId: args.request_id
        },
        paramsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
        call: { tool: kind === 'launch' ? 't3_thread_launch' : 't3_thread_send', arguments: call },
        history: {
          eventIds: frozen.snapshot.selected,
          lowerCursor: binding.delivered,
          floor: binding.floor,
          upperCutoff: args.event_id,
          omittedMessages: frozen.snapshot.omitted,
          omittedBytes: frozen.snapshot.omittedBytes
        }
      }

      bindingBefore = binding

      const admitted = this.o.ledger.tx(() => {
        const result = this.o.ledger.admit({
          principal: ctx.principal,
          requestId: args.request_id,
          eventId: args.event_id,
          paramsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
          callJson: JSON.stringify(call),
          fingerprint: this.o.t3.settingsFingerprint(),
          sessionId: session.sessionId,
          threadId,
          notAfter: this.o.now() + 120_000,
          epoch: ctx.routeEpoch,
          generation: ctx.generation,
          plan: 'codex'
        })

        if (!result.ok) {
          return false
        }

        this.store(ctx, args.request_id, frozen)
        this.o.ledger.setMeta(`${this.scope(ctx, args.room_id)}:active`, key)
        this.save(key, { ...binding, queueSince: age <= 900_000 ? event.originServerTs : binding.queueSince, threadId, open: args.request_id, accepted: args.event_id, selection })

        return true
      })

      if (!admitted) {
        return { class: 'refused', reason: 'event_already_used' }
      }

      const incarnation = this.o.t3.incarnation()

      if (!incarnation || !this.allowed(ctx)) {
        return this.o.ledger.tx(() => {
          this.o.ledger.update(ctx.principal, args.request_id, { state: 'void', reason: 'not_forwarded', settled: 'never_sent' })
          this.save(key, { ...binding, open: null })
          frozen.admission = { class: 'refused', receipt: 'void', reason: 'not_forwarded', forwarded: false }
          this.store(ctx, args.request_id, frozen)

          return frozen.admission
        })
      }

      this.o.ledger.markForwarded(ctx.principal, args.request_id, incarnation)

      // No await between final authority check, forwarded mark and starting native call.
      const reply =
        kind === 'launch'
          ? await this.o.t3.launch(session.token, call as never, this.o.modeLimit)
          : await this.o.t3.send?.(session.token, call as never, this.o.modeLimit)

      const runId = reply?.data?.runId

      const answer: RelayAnswer =
        reply?.transport === 'ok' && reply.status === 200 && !reply.isError && typeof runId === 'string'
          ? { class: 'accepted', request_id: args.request_id, threadId, runId }
          : { class: 'pending', request_id: args.request_id, forwarded: true }

      frozen.admission = answer
      this.o.ledger.tx(() => {
        this.store(ctx, args.request_id, frozen)

        if (typeof runId === 'string') {
          this.o.ledger.update(ctx.principal, args.request_id, { state: 'launched', run_id: runId })
        }
      })

      return this.allowed(ctx) ? answer : { class: 'revoked' }
    } catch {
      const row = this.o.ledger.receipt(ctx.principal, args.request_id)
      const frozen = this.frozen(ctx, args.request_id)

      if (row && !row.forwarded && frozen && bindingBefore) {
        const result: RelayAnswer = { class: 'refused', receipt: 'void', reason: 'not_forwarded', forwarded: false }
        this.o.ledger.tx(() => {
          this.o.ledger.update(ctx.principal, args.request_id, { state: 'void', reason: 'not_forwarded', settled: 'never_sent' })
          this.save(key, bindingBefore!)
          frozen.admission = result
          this.store(ctx, args.request_id, frozen)
        })

        return result
      }

      return this.o.ledger.receipt(ctx.principal, args.request_id)
        ? {
            class: 'pending',
            request_id: args.request_id,
            forwarded: this.o.ledger.receipt(ctx.principal, args.request_id)!.forwarded
          }
        : { class: 'refused', reason: 'admission_failed', forwarded: false }
    } finally {
      this.busy.delete(lock)
      this.requests.delete(requestKey)
    }
  }
  async status(ctx: CallContext, room: string): Promise<RelayAnswer> {
    const b = this.binding(this.key(ctx, room), '')
    const selection = this.o.selection?.(ctx.principal)

    return {
      gateId: this.o.gateId(),
      selection: selection
        ? { provider: 'atum-work', plan: 'codex', model: selection.model, revision: selection.revision }
        : null,
      reset: { epoch: b.epoch, historyFloor: b.floor },
      openOperation: b.open ? this.operation(ctx, b.open) : null,
      limits: [
        {
          plan: 'codex',
          state: this.o.limit?.().state ?? 'unknown',
          observedAt: this.o.now(),
          ...(this.o.limit?.().resetAt ? { resetsAt: this.o.limit!().resetAt } : {})
        }
      ],
      consent: this.o.consent(),
      connected:
        Boolean(selection) && this.o.fence(ctx) && (await this.o.t3.planProvider?.((await this.o.sessions.agent(ctx.principal)).token))?.status === 'connected',
      localSwitch: this.o.localSwitch()
    }
  }
  private holdReason(data?: Record<string, unknown> | null): string {
    const thread = (data?.thread ?? data) as Record<string, unknown> | undefined

    if (thread?.hold === 'plan_limit' || thread?.status === 'plan_limit' || this.o.limit?.().state === 'exhausted') {return 'plan_limit'}

    if (thread?.hold === 'approval' || thread?.status === 'approval' || thread?.pendingApproval || (Array.isArray(thread?.pendingApprovals) && thread.pendingApprovals.length)) {return 'approval'}

    return 'waiting_for_mac'
  }
  private async observe(token: string, threadId: string, runId: string): Promise<T3Reply> {
    const read = await this.o.t3.read(token, threadId)
    const run = read.kind === 'found' ? read.runs.find(r => r.runId === runId) : undefined
    const thread = read.kind === 'found' ? read.raw.thread as Record<string, unknown> | undefined : undefined

    const settled = read.kind === 'found' && !read.activeRunId && !thread?.blockedOnThreadWait &&
      !((thread?.pendingBackgroundTasks as unknown[] | undefined)?.length) &&
      !read.runs.some(r => ['running', 'queued', 'waiting', 'starting', 'preparing'].includes(r.status))

    return { transport: 'ok' as const, data: { ...(read.kind === 'found' ? read.raw : {}),
      timedOut: !settled || !run, resultRun: run, status: run?.status } }
  }
  private async readRaw(ctx: CallContext, id: string, timeoutMs: number): Promise<RelayAnswer> {
    if (!this.allowed(ctx)) {
      return { class: 'revoked' }
    }

    const f = this.frozen(ctx, id)
    let row = this.o.ledger.receipt(ctx.principal, id)

    if (!f) {
      return row?.state === 'refused' ? { class: 'refused', reason: row.reason } : { class: 'none' }
    }

    if (row?.state === 'void' && !row.forwarded) {return f.admission ?? { class: 'refused', receipt: 'void', reason: row.reason }}

    if (row?.stopScope) {
      return { class: 'revoked' }
    }

    if (!row?.threadId) {return { class: 'pending' }}

    if (!row.runId && row.forwarded) {
      const session = await this.o.sessions.agent(ctx.principal)

      if (session.sessionId !== row.sessionId) {return { class: 'revoked' }}
      let recovered: string | undefined

      if (f.kind === 'launch') {
        const found = await this.o.t3.read(session.token, row.threadId)

        if (found.kind === 'found') {recovered = found.runs.find(run => run.ordinal === 1)?.runId}
      } else if (this.o.t3.readPage) {
        // T3's native stableOperationMessageId; OAuth requestNamespace is client:<peer session id>.
        const messageId = `message:mcp:${encodeURIComponent(`client:${row.sessionId}`)}:thread-send:${encodeURIComponent(id)}`
        let position = -1

        for (let n = 0; n < 100; n++) {
          const page = await this.o.t3.readPage(session.token, row.threadId, position)

          if (page.transport !== 'ok' || page.isError) {break}

          const items = page.data?.items as
            { type: string; messageId: string; runId: string; sourceThreadId: string }[] | undefined

          const item = items?.find(
            i =>
              i.type === 'user_message' &&
              i.sourceThreadId === row!.threadId &&
              i.messageId === messageId &&
              typeof i.runId === 'string'
          )

          if (item) {
            recovered = item.runId

            break
          }

          if (!page.data?.hasMore || typeof page.data.nextPosition !== 'number' || page.data.nextPosition === position)
            {break}

          position = page.data.nextPosition
        }
      }

      if (!recovered || !this.allowed(ctx) || this.binding(f.bindingKey, '').epoch !== f.snapshot.epoch)
        {return { class: 'pending' }}

      this.o.ledger.update(ctx.principal, id, { run_id: recovered, state: 'launched' })
      row = this.o.ledger.receipt(ctx.principal, id)!
    }

    if (!row.runId) {return { class: 'pending' }}

    if (this.binding(f.bindingKey, '').epoch !== f.snapshot.epoch) {
      return { class: 'revoked' }
    }

    if (f.answer) {
      return f.answer
    }

    const session = await this.o.sessions.agent(ctx.principal)

    if (session.sessionId !== row.sessionId) {
      return { class: 'revoked' }
    }

    const waited = timeoutMs > 0
      ? await this.o.t3.wait(session.token, row.threadId, row.runId, Math.min(25_000, Math.max(1000, timeoutMs)))
      : await this.observe(session.token, row.threadId, row.runId)

    if (!this.allowed(ctx)) {
      return { class: 'revoked' }
    }

    if (waited.transport !== 'ok' || waited.isError || waited.data?.timedOut !== false) {
      f.hold = this.holdReason(waited.data)
      this.store(ctx, id, f)

      return { class: 'pending' }
    }

    f.hold = undefined
    const result = waited.data?.resultRun as { runId?: string; status?: string } | undefined
    const runId = result?.runId ?? row.runId
    const status = result?.status ?? waited.data?.status

    if (!['completed', 'failed', 'interrupted', 'cancelled'].includes(String(status))) {
      return { class: 'pending' }
    }

    if (!this.o.t3.readPage) {
      return { class: 'pending' }
    }

    let position: number | undefined = -1

    let final:
      { itemId: string; text: string; textTruncated?: boolean; nextTextOffset?: number; updatedAt?: string } | undefined

    // Bound each observer call; reaching the bound holds the operation, never returns a partial answer.
    let complete = false

    for (let n = 0; n < 100; n++) {
      const page = await this.o.t3.readPage(session.token, row.threadId, position)

      if (page.transport !== 'ok' || page.isError) {
        return { class: 'pending' }
      }

      const items = page.data?.items as
        | {
            runId: string
            sourceThreadId: string
            type: string
            itemId: string
            text: string
            textTruncated?: boolean
            nextTextOffset?: number
            updatedAt?: string
          }[]
        | undefined

      for (const item of items ?? []) {
        if (item.runId === runId && item.type === 'assistant_message' && typeof item.text === 'string') {
          final = item
        }
      }

      if (page.data?.hasMore === false) {
        complete = true

        break
      }

      const next = page.data?.nextPosition

      if (typeof next !== 'number' || next === position) {
        return { class: 'pending' }
      }

      position = next
    }

    if (!complete) {
      return { class: 'pending' }
    }

    if (final?.textTruncated) {
      let offset = final.nextTextOffset

      for (let n = 0; n < 100 && final.textTruncated; n++) {
        if (typeof offset !== 'number') {
          return { class: 'pending' }
        }

        const page = await this.o.t3.readPage(session.token, row.threadId, undefined, {
          itemId: final.itemId,
          textOffset: offset
        })

        const item = (page.data?.items as (typeof final)[] | undefined)?.find(i => i?.itemId === final?.itemId)

        if (page.transport !== 'ok' || page.isError || !item || item.nextTextOffset === offset) {
          return { class: 'pending' }
        }

        final = { ...item, text: final.text + item.text }
        offset = item.nextTextOffset
      }

      if (final.textTruncated) {
        return { class: 'pending' }
      }
    }

    if (
      !this.allowed(ctx) ||
      this.binding(f.bindingKey, '').epoch !== f.snapshot.epoch ||
      this.o.ledger.receipt(ctx.principal, id)?.stopScope
    ) {
      return { class: 'revoked' }
    }

    const answer: RelayAnswer = {
      class: 'ok',
      request_id: id,
      runId,
      status,
      text: status === 'completed' ? (final?.text ?? '') : '',
      itemId: final?.itemId ?? null,
      finishedAt:
        final?.updatedAt && Number.isFinite(Date.parse(final.updatedAt)) ? Date.parse(final.updatedAt) : this.o.now()
    }

    // Two overlapping reads freeze exactly one result.
    return this.o.ledger.tx(() => {
      const current = this.frozen(ctx, id)!

      if (current.answer) {
        return current.answer
      }

      current.answer = answer
      current.resultRun = runId
      this.store(ctx, id, current)
      this.o.ledger.update(ctx.principal, id, { finished: 1 })

      return answer
    })
  }
  /** Called only after cloud publication has reconciled; completion alone never releases the FIFO. */
  close(ctx: CallContext, id: string): boolean {
    if (!(this.o.authority?.(ctx) ?? this.allowed(ctx))) {
      return false
    }

    const f = this.frozen(ctx, id)

    const row = this.o.ledger.receipt(ctx.principal, id)

    if ((!f?.answer && !row?.settled) || !f || this.binding(f.bindingKey, '').epoch !== f.snapshot.epoch) {
      return false
    }

    if (f.closed) {
      return true
    }

    return this.o.ledger.tx(() => {
      const b = this.binding(f.bindingKey, '')

      if (b.open !== id) {
        return b.open === null
      }

      f.closed = true
      this.store(ctx, id, f)
      b.open = null
      b.delivered = f.input.event_id
      b.queueUntil = this.o.now()
      this.save(f.bindingKey, b)

      return true
    })
  }
  async resetReceipt(ctx: CallContext, room: string, id: string, floorEventId?: string): Promise<RelayAnswer> {
    const key = `${this.scope(ctx, room)}:reset:${id}`
    // Request identity is scoped to the assistant, so a changed room cannot replay it.
    const claim = `relay-reset:${ctx.principal}:${id}`

    if (!(this.o.resetAuthority?.(ctx) ?? this.allowed(ctx))) {return this.wire(ctx, id, { class: 'revoked' })}
    const existingRoom = this.o.ledger.meta(claim)

    if (existingRoom && existingRoom !== room) {return this.wire(ctx, id, { class: 'refused', reason: 'changed' })}
    let reset = JSON.parse(this.o.ledger.meta(key) ?? 'null') as { floor: string; epoch: number; confirmed: boolean } | null

    if (reset && floorEventId && reset.floor !== floorEventId) {return this.wire(ctx, id, { class: 'refused', reason: 'changed' })}

    if (!reset) {
      if (!floorEventId && !this.o.history?.boundary) {return this.wire(ctx, id, { class: 'refused', reason: 'history_unavailable' })}
      this.o.ledger.setMeta(claim, room)

      if (floorEventId) {
        const event = await this.o.owner.fetch({ agentPrincipal: ctx.principal, eventId: floorEventId })

        if (event.kind !== 'ok' || event.roomId !== room) {return this.wire(ctx, id, { class: 'refused', reason: 'owner_event_unverifiable' })}
      }

      const floor = floorEventId ?? await this.o.history!.boundary!({ agentPrincipal: ctx.principal, roomId: room })
      reset = { floor, epoch: this.binding(this.key(ctx, room), '').epoch + 1, confirmed: false }
      this.o.ledger.tx(() => {
        this.o.ledger.setMeta(claim, room)
        this.o.ledger.setMeta(key, JSON.stringify(reset))
      })
    }

    if (!reset.confirmed) {
      const binding = this.binding(this.key(ctx, room), '')

      if (binding.epoch >= reset.epoch && binding.floor === reset.floor) {reset.confirmed = true}
    }

    if (!reset.confirmed) {
      reset.confirmed = await this.reset(ctx, room, reset.floor, false, true)
      this.o.ledger.setMeta(key, JSON.stringify(reset))
    }

    return { gateId: this.o.gateId(), requestId: id, class: 'reset', receipt: 'reset', epoch: reset.epoch, stopConfirmed: reset.confirmed }
  }
  /** Main-only reset; the native stop must be confirmed before the durable epoch/floor advances. */
  async reset(ctx: CallContext, room: string, floor: string, withinAdmission = false, trustedBoundary = false): Promise<boolean> {
    const key = this.key(ctx, room)
    const lock = this.scope(ctx, room)

    if (!withinAdmission && this.busy.has(lock)) {
      return false
    }

    if (!withinAdmission) {this.busy.add(lock)}

    try {
      const b = this.binding(key, '')
      const event = trustedBoundary ? { kind: 'ok', roomId: room } : await this.o.owner.fetch({ agentPrincipal: ctx.principal, eventId: floor })

      if (event.kind !== 'ok' || event.roomId !== room || !(this.o.resetAuthority?.(ctx) ?? this.allowed(ctx))) {
        return false
      }

      this.save(key, { ...b, resetPending: true })

      if (b.open) {
        this.o.ledger.update(ctx.principal, b.open, { stop_scope: 'agent', stop_at: this.o.now() })
      }

      if (b.threadId) {
        const owner = await this.o.sessions.owner()
        await this.o.t3.interrupt(owner.token, b.threadId, { stop: true })
        const read = await this.o.t3.read(owner.token, b.threadId)

        if (
          read.kind !== 'found' ||
          read.activeRunId ||
          (read.raw.thread as { blockedOnThreadWait?: boolean })?.blockedOnThreadWait ||
          ((read.raw.thread as { pendingBackgroundTasks?: unknown[] })?.pendingBackgroundTasks?.length ?? 0) > 0 ||
          read.runs.some(r => ['running', 'queued', 'waiting', 'starting', 'preparing'].includes(r.status))
        ) {
          return false
        }
      }

      // Adapter proves the proposed boundary is after the existing floor by native room ordering.
      if (!this.o.history) {
        return false
      }

      if (b.floor !== floor) {
        const boundary = await this.o.history.read({ agentPrincipal: ctx.principal, roomId: room, before: floor, after: b.floor, floor: b.floor })

        if (b.floor && !Array.isArray(boundary) && boundary.truncated) {return false}
      }

      if (!(this.o.resetAuthority?.(ctx) ?? this.allowed(ctx))) {
        return false
      }

      const session = await this.o.sessions.agent(ctx.principal)
      this.o.ledger.tx(() => {
        if (b.open) {this.o.ledger.update(ctx.principal, b.open, { settled: 'stopped', finished: 1 })}

        const next: Binding = {
        epoch: b.epoch + 1,
        floor,
        threadId: null,
        sessionId: session.sessionId,
        open: null,
        accepted: null,
        delivered: null,
        selection: null
        }

        this.save(key, next)
        const nextKey = `${this.scope(ctx, room)}:${session.sessionId}`
        this.save(nextKey, next)
        this.o.ledger.setMeta(`${this.scope(ctx, room)}:active`, nextKey)
      })

      return true
    } finally {
      const current = this.binding(key, '')

      if (current.resetPending) {this.save(key, { ...current, resetPending: false })}

      if (!withinAdmission) {this.busy.delete(lock)}
    }
  }
}
