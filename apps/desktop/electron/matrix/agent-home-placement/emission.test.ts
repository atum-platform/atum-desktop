/**
 * What an agent says in a room, and who may say it (`fenceEmission`): every path that puts an agent's words into a room,
 * in every situation the placement model can put its Mac in.
 *
 * The paths are the commands of an agent's SDK host that make it say something (`AGENT_PUBLISH_KINDS`): its results, a
 * routine's result, a notice, a group notice and a task event, plus the owner's task files that the app sends on its
 * behalf. The situations are: the model does not govern the agent; the model governs it and this Mac is the home; the
 * drain barrier is up; this Mac has stood the agent down; another Mac is the home.
 */
import { describe, expect, it } from 'vitest'

import { AgentEmissions } from './emissions'
import { AgentHomeJournal } from './journal'
import type { HomePlatform } from './platform-client'
import {
  AGENT_PUBLISH_KINDS,
  type EmissionGuard,
  fenceEmission,
  guardAgentPublication,
  HomeStanding,
  NotTheHomeError
} from './standing'
import { createWorld, signal, type World } from './world.fixture'

/** Every kind the guard fences, as a command a caller would send (`publishResult` is one of the platform's ledger). */
const COMMANDS: Record<string, Record<string, unknown>> = {
  publishResult: { kind: 'publishResult', roomId: '!r:atum.example', body: 'answer', invocationId: '00000000-0000-4000-8000-bd7662a5eeb4', ledger: true },
  publishCron: { kind: 'publishCron', roomId: '!r:atum.example', body: 'daily', runId: 'r1', jobId: 'j1' },
  publishNotice: { kind: 'publishNotice', roomId: '!r:atum.example', body: 'working' },
  publishGroupNotice: { kind: 'publishGroupNotice', roomId: '!r:atum.example', body: 'joined' },
  sendAgentTask: { kind: 'sendAgentTask', roomId: '!r:atum.example', taskId: 't1', action: 'stopped', body: 'stopped' },
  sendTaskFiles: { kind: 'sendTaskFiles', roomId: '!r:atum.example', body: 'use these', userId: '@agent:atum.example' }
}

/** The kinds that have a ledger operation the platform's outbox can carry: only a result. */
const OUTBOXED = ['publishResult']
const DIRECT = [...AGENT_PUBLISH_KINDS].filter(kind => !OUTBOXED.includes(kind))

interface Rig {
  w: World
  journal: AgentHomeJournal
  standing: HomeStanding
  emissions: AgentEmissions
  sent: Array<Record<string, unknown>>
  outboxed: Array<Record<string, unknown>>
  flags: { stoodDown: boolean; discovered: number; activity: number }
  queue: { command(value: unknown, timeoutMs?: number): Promise<unknown> }
  guard: EmissionGuard & { agent(): string }
}

async function rig(
  options: { managed?: boolean; at?: 'a' | 'b'; platform?: (w: World) => HomePlatform; send?: (value: Record<string, unknown>) => Promise<unknown> } = {}
): Promise<Rig> {
  const w = await createWorld({ at: options.at ?? 'a' })
  const journal = new AgentHomeJournal(w.a.store)

  if (options.managed) {
    journal.update(w.agent, entry => {
      entry.managed = true
    })
  }

  const standing = new HomeStanding({
    platform: options.platform?.(w) ?? w.a.platform,
    journal,
    me: () => w.a.deviceServiceId,
    now: w.clock.now
  })

  const emissions = new AgentEmissions()
  const sent: Array<Record<string, unknown>> = []
  const outboxed: Array<Record<string, unknown>> = []
  const flags = { stoodDown: false, discovered: 0, activity: 0 }

  const guard: Rig['guard'] = {
    agent: () => w.agent,
    standing,
    flights: emissions,
    stoodDown: () => flags.stoodDown,
    outboxOnly: agent => emissions.outboxOnly(agent),
    discover: () => {
      flags.discovered += 1
    },
    activity: () => {
      flags.activity += 1
    },
    outbox: async command => {
      outboxed.push(command)

      return '$from-the-platform'
    }
  }

  const queue = guardAgentPublication(
    {
      command: async (value: unknown) => {
        const command = value as Record<string, unknown>
        sent.push(command)

        return options.send ? options.send(command) : '$sent-directly'
      }
    },
    guard
  )

  return { w, journal, standing, emissions, sent, outboxed, flags, queue, guard }
}

/** A platform that never answers a placement question until it is told to stop waiting. */
const silentPlatform = (): HomePlatform =>
  ({
    readPlacement: (_agent: string, abort: AbortSignal) =>
      new Promise(resolve => {
        abort.addEventListener('abort', () => resolve({ ok: false, kind: 'unavailable', status: 0 }), { once: true })
      })
  }) as unknown as HomePlatform

const asks = (w: World) => w.stub.requests.filter(request => request.method === 'GET').length

describe('every path that puts an agent’s words into a room', () => {
  it('is exactly the list the guard fences: a result, a routine, a notice, a group notice, a task event, the owner’s task files', () => {
    expect([...AGENT_PUBLISH_KINDS].sort()).toEqual(
      ['publishCron', 'publishGroupNotice', 'publishNotice', 'publishResult', 'sendAgentTask', 'sendTaskFiles'].sort()
    )
    expect(Object.keys(COMMANDS).sort()).toEqual([...AGENT_PUBLISH_KINDS].sort())
  })

  describe('of an agent the placement model does not govern', () => {
    it.each(Object.keys(COMMANDS))('sends %s at once: nothing is asked of the platform', async kind => {
      const r = await rig()

      await expect(r.queue.command(COMMANDS[kind])).resolves.toBe('$sent-directly')

      expect(r.sent).toEqual([COMMANDS[kind]])
      expect(r.outboxed).toEqual([])
      expect(r.w.stub.requests).toHaveLength(0)
    })

    it.each(Object.keys(COMMANDS))('does not wait for a platform that never answers to send %s', async kind => {
      const r = await rig({ platform: silentPlatform })

      const outcome = await Promise.race([
        r.queue.command(COMMANDS[kind]).then(() => 'sent'),
        new Promise<string>(resolve => setTimeout(() => resolve('still waiting'), 50))
      ])

      expect(outcome).toBe('sent')
      expect(r.sent).toHaveLength(1)
    })

    it('asks for a look at its placement in the background, and the send does not depend on the answer', async () => {
      const r = await rig()

      await r.queue.command(COMMANDS.publishNotice)
      await r.queue.command(COMMANDS.publishCron)

      expect(r.flags.discovered).toBe(2)
      expect(r.flags.activity).toBe(2)
    })

    it('is not touched by the drain barrier, the stand-down of another agent or the stub’s home', async () => {
      const r = await rig({ at: 'b' })

      // The placement says another Mac is the home, but the model has not taken this agent over here: today's rules.
      await expect(r.queue.command(COMMANDS.publishNotice)).resolves.toBe('$sent-directly')
      expect(r.w.stub.requests).toHaveLength(0)
    })
  })

  describe('of an agent the placement model governs, on the Mac that is its home', () => {
    it.each(DIRECT)('sends %s directly, and only after asking the platform right then', async kind => {
      const r = await rig({ managed: true })

      await expect(r.queue.command(COMMANDS[kind])).resolves.toBe('$sent-directly')

      expect(r.sent).toEqual([COMMANDS[kind]])
      expect(asks(r.w)).toBe(1)
    })

    it('asks every time: a verdict from a moment ago admits nothing', async () => {
      const r = await rig({ managed: true })

      await r.queue.command(COMMANDS.publishNotice)
      await r.queue.command(COMMANDS.publishNotice)
      await r.queue.command(COMMANDS.publishCron)

      expect(asks(r.w)).toBe(3)
    })

    it('puts a result through the platform’s outbox only, and sends nothing itself', async () => {
      const r = await rig({ managed: true })

      await expect(r.queue.command(COMMANDS.publishResult)).resolves.toBe('$from-the-platform')

      expect(r.outboxed).toEqual([COMMANDS.publishResult])
      expect(r.sent).toEqual([])
    })

    it('hands the outbox a way to send directly that is fenced like any other direct send', async () => {
      const r = await rig({ managed: true })
      r.guard.outbox = async (command, context) => context.direct(command, context.timeoutMs)

      await expect(r.queue.command(COMMANDS.publishResult)).resolves.toBe('$sent-directly')
      expect(r.sent).toEqual([COMMANDS.publishResult])

      // And once the barrier is up that same way is shut.
      r.emissions.switchToOutbox(r.w.agent)
      await expect(r.queue.command(COMMANDS.publishResult)).rejects.toBeInstanceOf(NotTheHomeError)
      expect(r.sent).toHaveLength(1)
    })
  })

  describe('whose home is another Mac', () => {
    it.each(Object.keys(COMMANDS))('refuses %s, and sends nothing', async kind => {
      const r = await rig({ managed: true, at: 'b' })
      r.guard.outbox = undefined

      await expect(r.queue.command(COMMANDS[kind])).rejects.toMatchObject({ name: 'NotTheHomeError', message: 'matrix_agent_not_home' })

      expect(r.sent).toEqual([])
    })

    it('holds a governed agent when the platform cannot be asked: it fails closed', async () => {
      const r = await rig({ managed: true })
      r.w.stub.failNext = { status: 500 }

      await expect(r.queue.command(COMMANDS.publishNotice)).rejects.toBeInstanceOf(NotTheHomeError)
      expect(r.sent).toEqual([])
    })
  })

  describe('after this Mac has stood the agent down', () => {
    it.each(Object.keys(COMMANDS))('refuses %s before asking anyone, governed or not', async kind => {
      for (const managed of [true, false]) {
        const r = await rig({ managed, at: 'a' })
        r.flags.stoodDown = true

        await expect(r.queue.command(COMMANDS[kind])).rejects.toBeInstanceOf(NotTheHomeError)

        expect(r.sent).toEqual([])
        expect(r.outboxed).toEqual([])
        expect(r.w.stub.requests).toHaveLength(0)
      }
    })

    it('refuses a send that was waiting for the platform when the stand-down came', async () => {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })

      const slow = (w: World): HomePlatform => ({
        ...w.a.platform,
        readPlacement: async (agent: string, abort: AbortSignal) => {
          await gate

          return w.a.platform.readPlacement(agent, abort)
        }
      }) as HomePlatform

      const r = await rig({ managed: true, platform: slow })
      const pending = r.queue.command(COMMANDS.publishNotice)
      await Promise.resolve()
      r.flags.stoodDown = true
      release()

      await expect(pending).rejects.toBeInstanceOf(NotTheHomeError)
      expect(r.sent).toEqual([])
    })
  })

  describe('while a move is draining: the barrier', () => {
    it.each(DIRECT)('refuses %s the moment the agent is switched to the platform’s outbox, and sends nothing', async kind => {
      const r = await rig({ managed: true })
      r.emissions.switchToOutbox(r.w.agent)

      await expect(r.queue.command(COMMANDS[kind])).rejects.toMatchObject({ name: 'NotTheHomeError' })

      expect(r.sent).toEqual([])
      // Refused on this Mac's own word: nobody is asked.
      expect(r.w.stub.requests).toHaveLength(0)
    })

    it('still sends a result, through the outbox, after the switch', async () => {
      const r = await rig({ managed: true })
      r.emissions.switchToOutbox(r.w.agent)

      await expect(r.queue.command(COMMANDS.publishResult)).resolves.toBe('$from-the-platform')

      expect(r.sent).toEqual([])
    })

    it('allows a send before the switch (it comes from the current home) and lets a drain wait for it', async () => {
      let land!: (value: string) => void
      const r = await rig({ managed: true, send: () => new Promise<string>(resolve => { land = resolve }) })

      const pending = r.queue.command(COMMANDS.publishNotice)

      // The platform is asked, the notice is on its way: in flight.
      await vi_tick()
      expect(r.sent).toHaveLength(1)
      expect(r.emissions.inFlight(r.w.agent)).toBe(1)

      r.emissions.switchToOutbox(r.w.agent)
      let settled = false
      const waiting = r.emissions.settled(r.w.agent, signal()).then(value => { settled = value })
      await vi_tick()
      expect(settled).toBe(false)

      land('$event')
      await expect(pending).resolves.toBe('$event')
      await waiting

      expect(settled).toBe(true)
      expect(r.emissions.inFlight(r.w.agent)).toBe(0)
    })

    it('refuses a send that was asking the platform when the barrier went up, and it never reaches the room', async () => {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })

      const slow = (w: World): HomePlatform => ({
        ...w.a.platform,
        readPlacement: async (agent: string, abort: AbortSignal) => {
          await gate

          return w.a.platform.readPlacement(agent, abort)
        }
      }) as HomePlatform

      const r = await rig({ managed: true, platform: slow })
      const pending = r.queue.command(COMMANDS.publishCron)
      await vi_tick()

      // It is counted from the first moment, so the barrier waits for it...
      expect(r.emissions.inFlight(r.w.agent)).toBe(1)
      r.emissions.switchToOutbox(r.w.agent)
      const waiting = r.emissions.settled(r.w.agent, signal())
      release()

      // ...and it comes out refused, never sent.
      await expect(pending).rejects.toMatchObject({ name: 'NotTheHomeError' })
      await expect(waiting).resolves.toBe(true)
      expect(r.sent).toEqual([])
    })

    it('says no when a send never lands, instead of waiting for ever', async () => {
      const r = await rig({ managed: true, send: () => new Promise(() => undefined) })
      void r.queue.command(COMMANDS.publishNotice)
      await vi_tick()

      r.emissions.switchToOutbox(r.w.agent)

      await expect(r.emissions.settled(r.w.agent, AbortSignal.timeout(30))).resolves.toBe(false)
    })

    it('counts the sends of an agent the model does not govern too: a drain that finds the agent governed waits for them', async () => {
      let land!: (value: string) => void
      const r = await rig({ send: () => new Promise<string>(resolve => { land = resolve }) })

      const pending = r.queue.command(COMMANDS.publishNotice)
      expect(r.emissions.inFlight(r.w.agent)).toBe(1)
      land('$e')
      await pending

      expect(r.emissions.inFlight(r.w.agent)).toBe(0)
    })

    it('lets the agent send directly again once the switch is released (the move ended without a commit)', async () => {
      const r = await rig({ managed: true })
      r.emissions.switchToOutbox(r.w.agent)
      await expect(r.queue.command(COMMANDS.publishNotice)).rejects.toBeInstanceOf(NotTheHomeError)

      r.emissions.release(r.w.agent)

      await expect(r.queue.command(COMMANDS.publishNotice)).resolves.toBe('$sent-directly')
    })
  })

  describe('a verdict from a few seconds ago', () => {
    it('does not admit a send once the platform has named another home, however recent the verdict', async () => {
      const r = await rig({ managed: true })

      // The controller's pass has just read the placement: this Mac is the home, and the verdict is cached.
      const placement = r.w.stub.placement(r.w.agent)
      r.standing.observe(r.w.agent, placement as never)
      expect(r.standing.last(r.w.agent)).toMatchObject({ state: 'home' })

      // A moment later the platform says otherwise. Nothing waited for the cache to run out.
      r.w.stub.hijack(r.w.agent, { kind: 'mac', deviceServiceId: r.w.b.deviceServiceId })

      for (const kind of DIRECT) {
        await expect(r.queue.command(COMMANDS[kind])).rejects.toBeInstanceOf(NotTheHomeError)
      }

      expect(r.sent).toEqual([])
    })
  })

  describe('the owner’s own message to the agent', () => {
    it('is fenced by hand like the rest: counted while it is sent, refused when this Mac has stood the agent down', async () => {
      const r = await rig({ managed: true })
      const owner: string[] = []

      const send = async () => {
        owner.push('sent')

        return '$owner'
      }

      await expect(fenceEmission(r.guard, r.w.agent, 'sendTaskFiles', { kind: 'sendTaskFiles' }, send)).resolves.toBe('$owner')

      r.flags.stoodDown = true
      await expect(fenceEmission(r.guard, r.w.agent, 'sendTaskFiles', { kind: 'sendTaskFiles' }, send)).rejects.toBeInstanceOf(NotTheHomeError)

      expect(owner).toEqual(['sent'])
    })
  })
})

/** One turn of the event loop and a little more: promises that need only microtasks have then run. */
const vi_tick = () => new Promise<void>(resolve => setTimeout(resolve, 5))
