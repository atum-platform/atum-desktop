import { describe, expect, it } from 'vitest'

import { matrixTurnId } from '../../shared/matrix-turn'

import {
  MATRIX_NONE_RETRY_WINDOW_MS,
  MATRIX_READ_ONLY_TOOLS,
  MATRIX_RESUME_NOTE_MAX,
  MATRIX_TURN_RERUNS,
  matrixResumeNote,
  matrixResumePrompt,
  matrixStatusTransaction,
  matrixToolNames,
  MatrixTurnEffects,
  matrixTurnEvidenceWith,
  matrixTurnResume,
  matrixTurnSettlement
} from './turn-effects'

describe('what a run is known to have done', () => {
  it('knows nothing about a run nobody tracked', () => {
    const effects = new MatrixTurnEffects()
    expect(effects.evidence().effect).toBe('unknown')
    // Even a tool seen: it stays unknown until the execution layer has taken the run.
    effects.toolStarted('terminal')
    expect(effects.evidence()).toEqual({ effect: 'unknown', tools: ['terminal'], blind: false })
  })

  it('proves nothing ran for a run that failed before the prompt left', () => {
    const effects = new MatrixTurnEffects()
    effects.attach()
    expect(effects.evidence()).toEqual({ effect: 'none', tools: [], blind: false })
    expect(effects.submitted).toBe(false)
  })

  it('treats model calls and read-only tools as no effect', () => {
    const effects = new MatrixTurnEffects()
    effects.attach()
    effects.toolProgress('all')
    effects.submit()
    expect(effects.evidence().effect).toBe('read_only')

    for (const tool of ['read_file', 'web_search', 'search_files']) {
      effects.toolStarted(tool)
    }

    expect(effects.evidence()).toEqual({ effect: 'read_only', tools: [], blind: false })
  })

  it('does not call a run read-only unless a tool start would have been seen', () => {
    for (const mode of ['new', 'all', 'verbose']) {
      const shown = new MatrixTurnEffects()
      shown.attach()
      shown.toolProgress(mode)
      shown.submit()
      expect(shown.evidence().effect).toBe('read_only')
    }

    // Off, never reported, or unrecognised: a tool could have run unseen.
    for (const mode of ['off', undefined, null, '', 'ALL', 7]) {
      const hidden = new MatrixTurnEffects()
      hidden.attach()
      hidden.toolProgress(mode)
      hidden.submit()
      expect(hidden.evidence()).toEqual({ effect: 'side_effect_possible', tools: [], blind: false })
    }

    // It does not change what is true of a run that never reached Hermes.
    const early = new MatrixTurnEffects()
    early.attach()
    early.toolProgress('off')
    expect(early.evidence().effect).toBe('none')
  })

  it('treats any other tool, known or not, as a possible side effect and keeps its name once', () => {
    const effects = new MatrixTurnEffects()
    effects.attach()
    effects.submit()
    effects.toolStarted('terminal')
    effects.toolStarted('terminal')
    effects.toolStarted('mcp_github_create_issue')
    effects.toolStarted('x'.repeat(200))
    effects.toolStarted('')
    expect(effects.evidence()).toEqual({
      effect: 'side_effect_possible',
      tools: ['terminal', 'mcp_github_create_issue', 'unnamed_tool'],
      blind: false
    })
  })

  it('bounds the tools it names and still says a side effect is possible', () => {
    const effects = new MatrixTurnEffects()
    effects.attach()
    effects.submit()

    for (let index = 0; index < 40; index++) {
      effects.toolStarted(`tool_${index}`)
    }

    const { effect, tools } = effects.evidence()
    expect(effect).toBe('side_effect_possible')
    expect(tools).toHaveLength(12)
  })

  it('loses sight of a run only after submission, and then rules out nothing', () => {
    const early = new MatrixTurnEffects()
    early.attach()
    early.blind()
    expect(early.evidence().effect).toBe('none')

    const late = new MatrixTurnEffects()
    late.attach()
    late.submit()
    late.blind()
    expect(late.evidence()).toEqual({ effect: 'side_effect_possible', tools: [], blind: true })
  })

  it('keeps todo read-only: it writes only the session own in-memory plan, which a resumed run rebuilds from history', () => {
    // Pinned on purpose (cross-family review of R3, finding 1, rejected): `todo` reads or writes
    // depending on its arguments and the tracker sees only the name, but a write changes nothing
    // outside the conversation (tools/todo_tool.py TodoStore is in memory, one per AIAgent, and
    // run_agent.py _hydrate_todo_store rebuilds it from history), so running it again repeats no
    // effect. Treating it as a side effect would turn plain planning runs into "couldn't confirm"
    // notices. tests/tools/test_todo_tool.py pins the premise on the Python side.
    expect(MATRIX_READ_ONLY_TOOLS.has('todo')).toBe(true)

    const effects = new MatrixTurnEffects()
    effects.attach()
    effects.toolProgress('all')
    effects.submit()
    effects.toolStarted('todo')
    expect(effects.evidence()).toEqual({ effect: 'read_only', tools: [], blind: false })

    // A run that did nothing but plan and then died is put back in the queue without a word...
    expect(matrixTurnSettlement({ evidence: effects.evidence(), reruns: 0, stopped: false, timedOut: false })).toEqual({
      kind: 'requeue',
      effect: 'read_only',
      tools: []
    })

    // ...but a real action next to it still counts.
    effects.toolStarted('terminal')
    expect(effects.evidence()).toEqual({ effect: 'side_effect_possible', tools: ['terminal'], blind: false })
  })

  it('never lists a read-only tool as one that may have changed something', () => {
    // The list is the contract: a tool that is not on it may have an effect.
    expect(MATRIX_READ_ONLY_TOOLS.has('terminal')).toBe(false)
    expect(MATRIX_READ_ONLY_TOOLS.has('write_file')).toBe(false)
    expect(MATRIX_READ_ONLY_TOOLS.has('execute_code')).toBe(false)
    expect(MATRIX_READ_ONLY_TOOLS.has('memory')).toBe(false)
    expect(MATRIX_READ_ONLY_TOOLS.has('cronjob')).toBe(false)
    expect(MATRIX_READ_ONLY_TOOLS.has('delegate_task')).toBe(false)
    expect(MATRIX_READ_ONLY_TOOLS.has('browser_click')).toBe(false)
    expect(MATRIX_READ_ONLY_TOOLS.has('atum_google')).toBe(false)
  })
})

describe('runtime process-group retirement', () => {
  it('keeps a tracked pre-submit or visible model-only runtime', () => {
    const effects = new MatrixTurnEffects()
    effects.attach()
    expect(effects.runtimeMayHaveActiveTool).toBe(false)
    effects.toolProgress('new')
    effects.submit()
    expect(effects.runtimeMayHaveActiveTool).toBe(false)
  })

  it('retires after any visible tool start, including a completed call with possible background work', () => {
    const effects = new MatrixTurnEffects()
    effects.attach()
    effects.toolProgress('new')
    effects.submit()
    effects.toolStarted('read_file')
    expect(effects.runtimeMayHaveActiveTool).toBe(true)
  })

  it('retires when tool starts were hidden or the submitted connection went blind', () => {
    const hidden = new MatrixTurnEffects()
    hidden.attach()
    hidden.submit()
    expect(hidden.runtimeMayHaveActiveTool).toBe(true)

    const blind = new MatrixTurnEffects()
    blind.attach()
    blind.toolProgress('new')
    blind.submit()
    blind.blind()
    expect(blind.runtimeMayHaveActiveTool).toBe(true)
  })
})

describe('the three cases', () => {
  const run = (effect: 'none' | 'read_only' | 'side_effect_possible' | 'unknown', tools: string[] = []) => ({
    evidence: { effect, tools, blind: false },
    reruns: 0,
    stopped: false,
    timedOut: false
  })

  it('queues a run again silently when nothing reached Hermes or only read-only work ran (a)', () => {
    expect(matrixTurnSettlement(run('none'))).toEqual({ kind: 'requeue', effect: 'none', tools: [] })
    expect(matrixTurnSettlement(run('read_only'))).toEqual({ kind: 'requeue', effect: 'read_only', tools: [] })
  })

  it('queues a run once more, as a check, when a side-effecting tool may have run (b)', () => {
    expect(matrixTurnSettlement(run('side_effect_possible', ['terminal']))).toEqual({
      kind: 'requeue',
      effect: 'side_effect_possible',
      tools: ['terminal']
    })
  })

  it('tells the owner when nothing can be shown (c)', () => {
    expect(matrixTurnSettlement(run('unknown'))).toEqual({ kind: 'notice', code: 'couldnt_confirm' })
  })

  it('does nothing for a run the owner stopped, whatever it did', () => {
    for (const effect of ['none', 'read_only', 'side_effect_possible', 'unknown'] as const) {
      expect(matrixTurnSettlement({ ...run(effect), stopped: true })).toEqual({ kind: 'leave' })
    }
  })

  it('stops running a message again after its reruns, and says what is true of it', () => {
    expect(matrixTurnSettlement({ ...run('read_only'), reruns: MATRIX_TURN_RERUNS - 1 }).kind).toBe('requeue')
    expect(matrixTurnSettlement({ ...run('read_only'), reruns: MATRIX_TURN_RERUNS })).toEqual({
      kind: 'notice',
      code: 'failed'
    })
  })

  it('retries a run that provably did nothing by age, not by count, and leaves every other effect on the count', () => {
    const young = MATRIX_NONE_RETRY_WINDOW_MS - 1
    expect(matrixTurnSettlement({ ...run('none'), reruns: MATRIX_TURN_RERUNS + 20, unrunnableMs: young }).kind).toBe('requeue')
    expect(matrixTurnSettlement({ ...run('none'), reruns: MATRIX_TURN_RERUNS + 20, unrunnableMs: MATRIX_NONE_RETRY_WINDOW_MS })).toEqual({
      kind: 'notice',
      code: 'failed'
    })
    // Without a clock the count is the bound, as before; reading is not "nothing".
    expect(matrixTurnSettlement({ ...run('none'), reruns: MATRIX_TURN_RERUNS }).kind).toBe('notice')
    expect(matrixTurnSettlement({ ...run('read_only'), reruns: MATRIX_TURN_RERUNS, unrunnableMs: 0 }).kind).toBe('notice')
  })

  it('gives a message that may have acted exactly one check: its own allowance, never a second', () => {
    // Not one of the silent reruns: a message whose reruns are spent is still checked once.
    expect(matrixTurnSettlement({ ...run('side_effect_possible', ['terminal']), reruns: MATRIX_TURN_RERUNS })).toEqual({
      kind: 'requeue',
      effect: 'side_effect_possible',
      tools: ['terminal']
    })

    // The check was itself cut off (the earlier run already said it may have acted): the owner is told, once.
    for (const reruns of [1, MATRIX_TURN_RERUNS, MATRIX_TURN_RERUNS + 3]) {
      expect(
        matrixTurnSettlement({
          ...run('side_effect_possible', ['terminal']),
          reruns,
          prior: { effect: 'side_effect_possible' }
        })
      ).toEqual({ kind: 'notice', code: 'couldnt_confirm' })
    }

    // An earlier run that only read does not make this one a check that already happened.
    expect(
      matrixTurnSettlement({ ...run('side_effect_possible', ['terminal']), reruns: 1, prior: { effect: 'read_only' } }).kind
    ).toBe('requeue')
  })

  it('does not run a message again that hit its time limit', () => {
    expect(matrixTurnSettlement({ ...run('none'), timedOut: true })).toEqual({ kind: 'notice', code: 'failed' })
    expect(matrixTurnSettlement({ ...run('side_effect_possible'), timedOut: true })).toEqual({
      kind: 'notice',
      code: 'couldnt_confirm'
    })
  })
})

describe('what earlier runs of the same message did', () => {
  const evidence = (effect: 'none' | 'read_only' | 'side_effect_possible', tools: string[] = []) => ({
    effect,
    tools,
    blind: false
  })

  it('adds up: a later run that only read does not undo an earlier one that may have changed something', () => {
    expect(
      matrixTurnEvidenceWith(evidence('read_only'), { effect: 'side_effect_possible', tools: ['terminal'] })
    ).toEqual({
      effect: 'side_effect_possible',
      tools: ['terminal'],
      blind: false
    })
    expect(
      matrixTurnEvidenceWith(evidence('none'), { effect: 'side_effect_possible', tools: ['terminal'] }).effect
    ).toBe('side_effect_possible')
  })

  it('keeps the tools of both, once each and bounded', () => {
    const merged = matrixTurnEvidenceWith(evidence('side_effect_possible', ['write_file', 'terminal']), {
      effect: 'side_effect_possible',
      tools: ['terminal', 'patch']
    })

    expect(merged.tools).toEqual(['terminal', 'patch', 'write_file'])

    const many = matrixTurnEvidenceWith(
      evidence(
        'side_effect_possible',
        Array.from({ length: 12 }, (_, index) => `new_${index}`)
      ),
      { effect: 'side_effect_possible', tools: Array.from({ length: 12 }, (_, index) => `old_${index}`) }
    )

    expect(many.tools).toHaveLength(12)
  })

  it('never makes a run look more certain than it was', () => {
    expect(
      matrixTurnEvidenceWith({ effect: 'unknown', tools: [], blind: false }, { effect: 'none', tools: [] }).effect
    ).toBe('unknown')
    expect(matrixTurnEvidenceWith(evidence('read_only'), { effect: 'none', tools: [] }).effect).toBe('read_only')
    expect(matrixTurnEvidenceWith(evidence('read_only'))).toEqual(evidence('read_only'))
  })
})

describe('the facts of an earlier run', () => {
  it('reads a platform resume and ignores a malformed one', () => {
    expect(
      matrixTurnResume({ attempt: 1, effect: 'side_effect_possible', tools: ['terminal', 7, 'bad name!'] })
    ).toEqual({
      attempt: 1,
      effect: 'side_effect_possible',
      tools: ['terminal']
    })

    for (const bad of [
      undefined,
      null,
      'x',
      {},
      { attempt: 0, effect: 'none', tools: [] },
      { attempt: 1.5, effect: 'none', tools: [] },
      { attempt: 1, effect: 'unknown', tools: [] },
      { attempt: 1, effect: 'none', tools: 'terminal' }
    ]) {
      expect(matrixTurnResume(bad)).toBeUndefined()
    }
  })

  it('keeps only well-formed tool names, bounded', () => {
    expect(matrixToolNames(['a', 'b c', 3, 'd.e:f/g-h_i'])).toEqual(['a', 'd.e:f/g-h_i'])
    expect(matrixToolNames('terminal')).toEqual([])
    expect(matrixToolNames(Array.from({ length: 30 }, (_, index) => `t${index}`))).toHaveLength(12)
  })

  it('writes the note to the assistant, labelled as Atum’s and bounded', () => {
    const note = matrixResumeNote({ tools: ['terminal', 'write_file'] })
    expect(note.startsWith('[Atum note, not written by the person')).toBe(true)
    expect(note).toContain('terminal, write_file')
    expect(note).toMatch(/only a check/)
    expect(note).toMatch(/Do not repeat or redo any action/)
    expect(note).toMatch(/tell the person/)
    expect(note).toMatch(/ask whether to do it/)
    expect(note.length).toBeLessThanOrEqual(MATRIX_RESUME_NOTE_MAX)
    expect(matrixResumeNote({ tools: [] })).toContain('not known which tools')
  })

  it('adds the note to the one prompt, after the person’s words and cutting none of them', () => {
    const prompt = matrixResumePrompt('Delete the old drafts', { tools: ['terminal'] }, 48_000)
    expect(prompt.startsWith('Delete the old drafts\n\n[Atum note')).toBe(true)
    // Nothing earlier changes: the prompt is a prefix of the resumed one.
    expect(prompt.startsWith('Delete the old drafts')).toBe(true)
  })

  it('keeps the warning however many tool names there are and however long they are', () => {
    const worst = Array.from({ length: 12 }, (_, index) => `mcp_${'server'.repeat(8)}_tool_${index}`.slice(0, 64))
    const note = matrixResumeNote({ tools: worst })
    expect(note.length).toBeLessThanOrEqual(MATRIX_RESUME_NOTE_MAX)
    expect(note).toMatch(/Do not repeat or redo any action/)
    expect(note).toMatch(/ask whether to do it/)
    expect(note).toMatch(/tell the person/)
    // The list gives way ("a, b and 4 more"), never the warning.
    expect(note).toMatch(/and \d+ more\./)
    expect(note).toContain(worst[0])

    for (const length of [20, 30, 40, 50, 64]) {
      const tools = Array.from(
        { length: 12 },
        (_, index) => `${'t'.repeat(length - 2)}${String(index).padStart(2, '0')}`
      )

      const fitted = matrixResumeNote({ tools })
      expect(fitted.length).toBeLessThanOrEqual(MATRIX_RESUME_NOTE_MAX)
      expect(fitted).toMatch(/tell the person/)
    }

    // The tools are still said to exist when none can be named.
    expect(matrixResumeNote({ tools: ['t'.repeat(64)] }).length).toBeLessThanOrEqual(MATRIX_RESUME_NOTE_MAX)
  })

  it('always carries the note, even beside a prompt that leaves it no room', () => {
    const full = matrixResumePrompt('x'.repeat(48_000), { tools: ['terminal'] }, 48_000)
    expect(full.length).toBeLessThanOrEqual(48_000)
    expect(full).toMatch(/\[Atum note, not written by the person/)
    expect(full.startsWith('x'.repeat(40_000))).toBe(true)

    const near = matrixResumePrompt(
      'x'.repeat(47_900),
      { tools: Array.from({ length: 12 }, (_, i) => `a_tool_name_of_forty_chars_${i}`.padEnd(40, 'z')) },
      48_000
    )

    expect(near.length).toBeLessThanOrEqual(48_000)
    expect(near).toMatch(/tell the person/)
  })
})

describe('the notice’s transaction', () => {
  const base = { agentPrincipal: 'agent', roomId: '!room:test', eventId: '$event', code: 'couldnt_confirm' }

  it('is the same on every attempt and every Mac, and shaped like an ID the ledger issues', () => {
    const first = matrixStatusTransaction(base)
    expect(matrixStatusTransaction({ ...base })).toBe(first)
    expect(first).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/)
    // The shape every check on a result's invocation accepts (continuity reads it as an agent reply).
    expect(matrixTurnId(first)).toBe(first)
  })

  it('differs by message, agent and kind of notice', () => {
    const ids = new Set([
      matrixStatusTransaction(base),
      matrixStatusTransaction({ ...base, eventId: '$other' }),
      matrixStatusTransaction({ ...base, agentPrincipal: 'other' }),
      matrixStatusTransaction({ ...base, roomId: '!other:test' }),
      matrixStatusTransaction({ ...base, code: 'failed' })
    ])

    expect(ids.size).toBe(5)
  })
})
