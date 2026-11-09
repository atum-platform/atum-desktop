import { expect, it, vi } from 'vitest'

import { registerMatrixDocumentDetach, runMatrixDocumentAction } from './text-document-actions'

it('retains the editor until its latest draft is acknowledged', async () => {
  let acknowledge!: () => void
  const pending = new Promise<void>(resolve => {acknowledge = resolve})
  const release = registerMatrixDocumentDetach(() => pending)
  const action = vi.fn(async () => 'closed')
  try {
    const closing = runMatrixDocumentAction(action)
    expect(action).not.toHaveBeenCalled()
    acknowledge()
    await expect(closing).resolves.toBe('closed')
    expect(action).toHaveBeenCalledOnce()
  } finally {release()}
})

it('keeps the editor when checkpointing fails or its scope disappears', async () => {
  const action = vi.fn(async () => undefined)
  const release = registerMatrixDocumentDetach(() => Promise.reject(new Error('conflict')))
  await expect(runMatrixDocumentAction(action)).rejects.toThrow('conflict')
  release()
  let acknowledge!: () => void
  const pending = new Promise<void>(resolve => {acknowledge = resolve})
  const revoke = registerMatrixDocumentDetach(() => pending)
  const closing = runMatrixDocumentAction(action)
  revoke()
  acknowledge()
  await expect(closing).rejects.toThrow('MATRIX_TEXT_DOCUMENT_UNAVAILABLE')
  expect(action).not.toHaveBeenCalled()
})

it('resumes only the still-active pane after an action rejects following preflight', async () => {
  const resume = vi.fn()
  const prepare = Object.assign(async () => undefined, { resumeAfterActionFailure: resume })
  const release = registerMatrixDocumentDetach(prepare)
  try {
    await expect(runMatrixDocumentAction(async () => { throw new Error('blocked') })).rejects.toThrow('blocked')
    expect(resume).toHaveBeenCalledOnce()
  } finally {release()}
})

it('does not resume an old or replacement pane when the active guard changes after preflight', async () => {
  let acknowledge!: () => void
  const pending = new Promise<void>(resolve => {acknowledge = resolve})
  const oldResume = vi.fn()
  const old = Object.assign(() => pending, { resumeAfterActionFailure: oldResume })
  const releaseOld = registerMatrixDocumentDetach(old)
  const closing = runMatrixDocumentAction(async () => undefined)
  const replacementResume = vi.fn()
  const releaseReplacement = registerMatrixDocumentDetach(
    Object.assign(async () => undefined, { resumeAfterActionFailure: replacementResume })
  )
  acknowledge()

  await expect(closing).rejects.toThrow('MATRIX_TEXT_DOCUMENT_UNAVAILABLE')
  expect(oldResume).not.toHaveBeenCalled()
  expect(replacementResume).not.toHaveBeenCalled()
  releaseOld()
  releaseReplacement()
})
