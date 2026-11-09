import { describe, expect, it } from 'vitest'

import {
  foldMatrixHandle,
  localMatrixHandleProblem,
  MATRIX_AGENT_STEM_MAX,
  matrixAgentHandleCandidates,
  matrixAgentHandleFromStem,
  matrixAgentHandleStem,
  matrixHandleCheckProblem,
  matrixHandleNextChange,
  numberedMatrixAgentHandle,
  suggestMatrixAgentHandle,
  typedMatrixAgentHandleStem
} from './handle-rules'

describe('public handle rules on the desktop', () => {
  it('folds what was typed as the directory reads it, and never maps a character', () => {
    expect(foldMatrixHandle('  @Lan_Nguyen ')).toBe('lan_nguyen')
    expect(localMatrixHandleProblem(foldMatrixHandle('@Lan_Nguyen'), 'person')).toBeNull()

    for (const typed of ['la', 'a'.repeat(33), '1lan', 'lan-nguyen', 'lan.nguyen', 'mình', 'lan nguyen']) {
      expect(localMatrixHandleProblem(foldMatrixHandle(typed), 'person')).toBe('invalid')
    }
  })

  it('keeps _bot for assistants and off people, so the two can never share a name', () => {
    expect(localMatrixHandleProblem('lan_bot', 'agent')).toBeNull()
    expect(localMatrixHandleProblem('lan', 'agent')).toBe('botRequired')
    expect(localMatrixHandleProblem('lan_bot', 'person')).toBe('botReserved')

    for (const handle of ['lan', 'lan_bot', 'x_bot', 'moon_garden_bot']) {
      const asAgent = localMatrixHandleProblem(handle, 'agent') === null
      const asPerson = localMatrixHandleProblem(handle, 'person') === null
      expect(asAgent && asPerson).toBe(false)
    }
  })

  it('reads every refusal the directory sends, and an unknown one as unavailable', () => {
    expect(matrixHandleCheckProblem(null)).toBeNull()
    expect(matrixHandleCheckProblem('alias_reserved')).toBe('reserved')
    expect(matrixHandleCheckProblem('alias_unavailable')).toBe('unavailable')
    expect(matrixHandleCheckProblem('alias_bot_suffix_required')).toBe('botRequired')
    expect(matrixHandleCheckProblem('alias_something_new')).toBe('unavailable')
  })

  it('offers an assistant a valid handle from its name, or nothing', () => {
    for (const name of [
      'Alfred',
      'Trợ lý Đức',
      'Council',
      'T',
      '  Mai Anh  ',
      'Ω'.repeat(3),
      '2049 Analyst',
      'x'.repeat(60),
      ''
    ]) {
      const suggestion = suggestMatrixAgentHandle(name)

      // Whatever is offered passes the rules an assistant's handle must pass.
      expect(suggestion === '' || localMatrixHandleProblem(suggestion, 'agent') === null).toBe(true)
    }

    expect(suggestMatrixAgentHandle('Trợ lý Đức')).toBe('tro_ly_duc_bot')
    expect(suggestMatrixAgentHandle('2049 Analyst')).toBe('analyst_bot')
    expect(suggestMatrixAgentHandle('ΩΩΩ')).toBe('')
  })

  it('derives a new assistant’s handles from its name: the plain one first, then short numbers, then a fallback', () => {
    const fixed = () => 0.5
    const [fromName, ...rest] = matrixAgentHandleCandidates('Tiếp thị', fixed)

    expect(fromName[0]).toBe('tiep_thi_bot')
    expect(fromName.length).toBeGreaterThan(1)

    for (const handle of fromName.slice(1)) {
      expect(handle).toMatch(/^tiep_thi\d{2,4}_bot$/)
    }

    // A reserved name falls through to the same fallback a name with no usable letters gets.
    expect(rest).toEqual(matrixAgentHandleCandidates('小助手', fixed))
  })

  it('offers only distinct, well-formed assistant handles for any name, even one with no letters to use', () => {
    for (const name of ['Tiếp thị', 'Đức', 'x'.repeat(60), 'agent 2', '小助手', 'ΩΩΩ', '', '  ', '2049', 'Trợ thủ']) {
      for (const random of [() => 0, () => 0.999, Math.random]) {
        const groups = matrixAgentHandleCandidates(name, random)
        const candidates = groups.flat()

        expect(groups.length).toBeGreaterThan(0)
        expect(new Set(candidates).size).toBe(candidates.length)

        for (const handle of candidates) {
          expect(localMatrixHandleProblem(handle, 'agent')).toBeNull()
        }
      }
    }
  })

  it('never falls back to a handle the directory reads as its reserved Vietnamese word for assistant', () => {
    // The directory drops `_bot`, up to four trailing digits and every `_` before it compares
    // a handle with its reserved names; "troly" (Trợ lý) is one of them.
    const directoryReading = (handle: string) => handle.replace(/_bot$/, '').replace(/_?\d{1,4}$/, '').replaceAll('_', '')

    for (const random of [() => 0, () => 0.999, Math.random]) {
      for (const handle of matrixAgentHandleCandidates('小助手', random).flat()) {
        expect(directoryReading(handle)).not.toBe('troly')
      }
    }
  })

  it('dates the next change from the wait the platform names', () => {
    const now = Date.UTC(2026, 9, 8, 12)
    expect(matrixHandleNextChange(30 * 86400, now).toISOString()).toBe('2026-11-07T12:00:00.000Z')
  })

  it('reads a typed assistant handle the way a name is, without doubling what the field shows', () => {
    expect(typedMatrixAgentHandleStem('Tiếp thị')).toBe('tiep_thi')
    expect(typedMatrixAgentHandleStem('@Đức_bot')).toBe('duc')
    expect(typedMatrixAgentHandleStem('tiep_')).toBe('tiep')
    expect(typedMatrixAgentHandleStem('Bếp Trưởng ')).toBe('bep_truong')
    expect(typedMatrixAgentHandleStem('tiep_bot_')).toBe('tiep')
    // Only a final `_bot` is the shown ending; one inside a word is part of the stem.
    expect(typedMatrixAgentHandleStem('tro_ly_botanic')).toBe('tro_ly_botanic')
    expect(typedMatrixAgentHandleStem('my_botanist')).toBe('my_botanist')
    expect([...typedMatrixAgentHandleStem('a'.repeat(80))]).toHaveLength(MATRIX_AGENT_STEM_MAX)

    // The field's stem and the whole handle go back and forth, and an empty field is no handle.
    for (const handle of ['tiep_thi_bot', 'lan_bot', 'tro_thu42_bot']) {
      expect(matrixAgentHandleFromStem(matrixAgentHandleStem(handle))).toBe(handle)
    }

    expect(matrixAgentHandleFromStem('')).toBe('')

    // Whatever is typed, a handle made from it is either well formed or refused locally as invalid.
    for (const typed of ['Bếp Trưởng', '1abc', '  @@x ', 'ΩΩ', 'mai anh  ', 'a'.repeat(80)]) {
      const handle = matrixAgentHandleFromStem(typedMatrixAgentHandleStem(typed))
      expect(handle === '' || [null, 'invalid'].includes(localMatrixHandleProblem(handle, 'agent'))).toBe(true)
    }
  })

  it('tries the handle the person chose first, then the name’s, then the fallback, never twice', () => {
    const fixed = () => 0.5
    const groups = matrixAgentHandleCandidates('Tiếp thị', fixed, 'bep_truong')

    expect(groups.map(group => group[0])).toEqual(['bep_truong_bot', 'tiep_thi_bot', 'tro_thu_bot'])
    // A chosen stem that is the name's own is one group, not two; an unusable one is ignored.
    expect(matrixAgentHandleCandidates('Tiếp thị', fixed, 'tiep_thi')).toEqual(matrixAgentHandleCandidates('Tiếp thị', fixed))
    expect(matrixAgentHandleCandidates('Tiếp thị', fixed, '1x')).toEqual(matrixAgentHandleCandidates('Tiếp thị', fixed))
  })

  it('offers, for a taken handle, the same stem with a short number', () => {
    for (const stem of ['tiep_thi', 'agent2049', 'a'.repeat(MATRIX_AGENT_STEM_MAX)]) {
      const offered = numberedMatrixAgentHandle(stem, Math.random)!

      expect(localMatrixHandleProblem(offered, 'agent')).toBeNull()
      expect(offered).not.toBe(`${stem}_bot`)
      expect(offered.startsWith(stem.slice(0, 10))).toBe(true)
    }
  })
})
