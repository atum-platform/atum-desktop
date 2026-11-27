import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { MatrixCommand, MatrixUiBridge } from '../../../shared/matrix'

import { MatrixVoiceLedge, MatrixVoiceStart, useMatrixVoiceNote } from './composer'
import { startMatrixVoiceRecording } from './recording'

vi.mock('./recording', () => ({ startMatrixVoiceRecording: vi.fn() }))

function ComposerFixture() {
  const voice = useMatrixVoiceNote('!room:test')

  return voice.state.kind === 'idle'
    ? <MatrixVoiceStart start={() => void voice.start()} />
    : <MatrixVoiceLedge disabled={false} voice={voice} />
}

function fixture(granted = true) {
  const command = vi.fn<(input: MatrixCommand) => Promise<unknown>>(async () => '$sent')
  const transcribe = vi.fn()
  const microphone = vi.fn(async () => granted)
  window.atumMatrix = { voice: { microphone, transcribe }, command } as unknown as MatrixUiBridge
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }))
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  const draft = { bytes: new Uint8Array([10, 20]), duration: 1000, waveform: [128] }

  let finish: (value: typeof draft | null) => void = () => {}
  const result = new Promise<typeof draft | null>(resolve => { finish = resolve })

  const recorder = {
    cancel: vi.fn(() => finish(null)),
    stop: vi.fn(() => finish(draft)),
    peaks: () => [128],
    result
  }

  vi.mocked(startMatrixVoiceRecording).mockReturnValue(recorder)
  render(<ComposerFixture />)

  return { command, draft, getUserMedia, microphone, recorder, transcribe }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'atumMatrix')
})

it('cancels locally without sending or invoking transcription', async () => {
  const f = fixture()
  expect(f.getUserMedia).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Record voice note' }))
  await screen.findByRole('button', { name: 'Stop recording' })
  fireEvent.click(screen.getByRole('button', { name: 'Discard voice note' }))
  await screen.findByRole('button', { name: 'Record voice note' })
  expect(f.recorder.cancel).toHaveBeenCalledOnce()
  expect(f.command).not.toHaveBeenCalled()
  expect(f.transcribe).not.toHaveBeenCalled()
})

it('reviews a playable note and uploads only after Send', async () => {
  const f = fixture()
  fireEvent.click(screen.getByRole('button', { name: 'Record voice note' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }))
  expect(await screen.findByRole('button', { name: 'Play voice note' })).toBeTruthy()
  expect(f.command).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Send voice note' }))
  await waitFor(() => expect(f.command).toHaveBeenCalledWith({
    kind: 'attach', roomId: '!room:test', name: 'Voice note.ogg', bytes: f.draft.bytes,
    voiceNote: { duration: f.draft.duration, waveform: f.draft.waveform }
  }))
  expect(f.transcribe).not.toHaveBeenCalled()
})

it('asks inline on the first send, and Not now keeps the playable draft', async () => {
  const f = fixture()
  f.command.mockResolvedValue({ kind: 'transcriptionRequired', provider: 'groq' })
  fireEvent.click(screen.getByRole('button', { name: 'Record voice note' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Send voice note' }))
  expect(await screen.findByText('Transcribe with Groq?')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
  expect(screen.queryByText('Transcribe with Groq?')).toBeNull()
  expect(screen.getByRole('button', { name: 'Play voice note' })).toBeTruthy()
  expect(f.command).toHaveBeenCalledTimes(1)
  expect(f.command.mock.calls[0]?.[0]).not.toHaveProperty('transcriptionProvider')

  fireEvent.click(screen.getByRole('button', { name: 'Send voice note' }))
  await screen.findByText('Transcribe with Groq?')
  f.command.mockResolvedValue('$sent')
  fireEvent.click(screen.getByRole('button', { name: 'OK' }))
  await screen.findByRole('button', { name: 'Record voice note' })
  expect(f.command.mock.lastCall?.[0]).toMatchObject({
    kind: 'attach', transcriptionProvider: 'groq', bytes: f.draft.bytes
  })
  expect(f.transcribe).not.toHaveBeenCalled()
})

it('gives a recoverable line if the native microphone prompt is refused', async () => {
  const f = fixture(false)
  fireEvent.click(screen.getByRole('button', { name: 'Record voice note' }))
  expect(await screen.findByText('Allow microphone access in System Settings, then try again.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Record voice note' })).toBeTruthy()
  expect(f.getUserMedia).not.toHaveBeenCalled()
  expect(f.command).not.toHaveBeenCalled()
})
