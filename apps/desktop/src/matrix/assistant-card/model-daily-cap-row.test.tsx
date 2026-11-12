import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixModelDailyCapView, MatrixModelDestinationsView } from '../../../shared/matrix-models'

import { ModelDailyCapRow } from './model-daily-cap-row'

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'

const NORMAL: MatrixModelDailyCapView = {
  dailyProtons: 200000,
  revision: 3,
  spend: { day: '2026-10-18', usedProtons: 42000, state: 'normal', notice: 'none' }
}

const WARNING: MatrixModelDailyCapView = {
  ...NORMAL,
  spend: { day: '2026-10-18', usedProtons: 160000, state: 'warning', notice: 'eighty_percent' }
}

const EXHAUSTED: MatrixModelDailyCapView = {
  ...NORMAL,
  spend: { day: '2026-10-18', usedProtons: 200000, state: 'exhausted', notice: 'exhausted' }
}

const UNLIMITED: MatrixModelDailyCapView = {
  ...NORMAL,
  dailyProtons: 0,
  spend: { day: '2026-10-18', usedProtons: 250000, state: 'normal', notice: 'none' }
}

let save: ReturnType<
  typeof vi.fn<(principal: string, dailyProtons: number) => Promise<{ status: 'saved' | 'refused' }>>
>

let read: ReturnType<typeof vi.fn<(principal: string) => Promise<MatrixModelDestinationsView | undefined>>>

let onView: ReturnType<typeof vi.fn<(view: MatrixModelDestinationsView) => void>>

function renderRow(cap = NORMAL, locale = 'vi') {
  save = vi.fn(async () => ({ status: 'saved' as const }))
  read = vi.fn(async () => undefined)
  onView = vi.fn()

  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <div className="atum-settings-group">
        <ModelDailyCapRow
          bridge={{ cap: save, read, write: vi.fn(async () => ({ status: 'saved' as const })), writeSubscription: vi.fn(async () => ({ status: 'saved' as const })) }}
          cap={cap}
          onView={onView}
          principal={AGENT}
        />
      </div>
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
})

beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
)

describe('the assistant card’s daily cap row', () => {
  it('shows the stored limit, not a spend meter, and says nothing when usage is normal', () => {
    renderRow()

    expect(screen.getByText('Hạn mức mỗi ngày')).toBeTruthy()
    expect(screen.getByText('200.000 Proton')).toBeTruthy()
    expect(screen.queryByText(/42\.000/)).toBeNull()
    expect(screen.queryByText(/gần chạm|đã chạm/)).toBeNull()
  })

  it('shows no line when usage is only near the limit', () => {
    renderRow(WARNING)

    expect(screen.queryByText('Hôm nay đã gần chạm hạn mức.')).toBeNull()
    expect(screen.queryByText(/dừng|không thể trả lời/)).toBeNull()
  })

  it('shows one honest line when the server says the limit is reached, never a stop claim', () => {
    renderRow(EXHAUSTED)

    const line = screen.getByText('Hôm nay đã chạm hạn mức.')

    expect(line.getAttribute('data-assistant-card-daily-cap-state')).toBe('exhausted')
    expect(line.textContent).not.toMatch(/dừng|tạm ngưng/)
  })

  it('reads 0 as no limit', () => {
    renderRow(UNLIMITED)

    expect(screen.getByText('Không giới hạn')).toBeTruthy()
    expect(screen.queryByText(/250\.000/)).toBeNull()
  })

  it('speaks English for the row and shows no nearly-reached warning at 80%', () => {
    renderRow(WARNING, 'en')

    expect(screen.getByText('Daily limit')).toBeTruthy()
    expect(screen.getByText('200,000 Protons')).toBeTruthy()
    expect(screen.queryByText("Today's limit is nearly reached.")).toBeNull()
  })

  it('says one Proton in English, not one Protons', () => {
    renderRow({ ...NORMAL, dailyProtons: 1 }, 'en')

    expect(screen.getByText('1 Proton')).toBeTruthy()
    expect(screen.queryByText('1 Protons')).toBeNull()
  })

  it('renders the normal, exhausted and unlimited states in English too', () => {
    const normal = renderRow(NORMAL, 'en')

    expect(screen.getByText('200,000 Protons')).toBeTruthy()
    expect(screen.queryByText(/Today's limit/)).toBeNull()
    normal.unmount()

    const exhausted = renderRow(EXHAUSTED, 'en')

    expect(screen.getByText("Today's limit is reached.")).toBeTruthy()
    exhausted.unmount()

    renderRow(UNLIMITED, 'en')
    expect(screen.getByText('No limit')).toBeTruthy()
    expect(screen.queryByText(/250,000/)).toBeNull()
  })

  it('writes a new Proton limit and shows it once the write is accepted', async () => {
    renderRow()

    fireEvent.click(screen.getByRole('button', { name: /Hạn mức mỗi ngày/ }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.input(within(dialog).getByLabelText('Proton mỗi ngày'), { target: { value: '250000' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }))

    await waitFor(() => expect(save).toHaveBeenCalledWith(AGENT, 250000))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('250.000 Proton')).toBeTruthy()
  })

  it('writes 0 from “Không giới hạn”', async () => {
    renderRow()

    fireEvent.click(screen.getByRole('button', { name: /Hạn mức mỗi ngày/ }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Không giới hạn' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }))

    await waitFor(() => expect(save).toHaveBeenCalledWith(AGENT, 0))
    await waitFor(() => expect(screen.getByText('Không giới hạn')).toBeTruthy())
  })

  it('keeps the previous value on a refusal and offers a plain retry, never a raw error', async () => {
    renderRow()
    save.mockResolvedValueOnce({ status: 'refused' })

    fireEvent.click(screen.getByRole('button', { name: /Hạn mức mỗi ngày/ }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.input(within(dialog).getByLabelText('Proton mỗi ngày'), { target: { value: '300000' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Chưa lưu được hạn mức. Hãy thử lại.'))
    // The row still says what the server last said; a fresh read settles a stale revision.
    expect(screen.getByRole('button', { name: /Hạn mức mỗi ngày/ }).textContent).toMatch(/200\.000 Proton/)
    expect(read).toHaveBeenCalledWith(AGENT)
    expect(screen.queryByText(/409|matrix_|revision/i)).toBeNull()
  })

  it('refuses a fraction or an empty amount before it reaches the bridge', async () => {
    renderRow()

    fireEvent.click(screen.getByRole('button', { name: /Hạn mức mỗi ngày/ }))

    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByLabelText('Proton mỗi ngày')

    fireEvent.input(input, { target: { value: '2.5' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }))
    expect(within(dialog).getByRole('status').textContent).toBe('Hãy nhập một số Proton nguyên.')
    expect(save).not.toHaveBeenCalled()

    fireEvent.input(input, { target: { value: '' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }))
    expect(within(dialog).getByRole('status').textContent).toBe('Hãy nhập một số Proton nguyên.')
    expect(save).not.toHaveBeenCalled()

    // Only plain digits count: hex or exponent spellings never save a surprising number.
    for (const value of ['0x10', '1e3', '-5']) {
      fireEvent.input(input, { target: { value } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }))
      expect(within(dialog).getByRole('status').textContent).toBe('Hãy nhập một số Proton nguyên.')
    }

    expect(save).not.toHaveBeenCalled()
  })
})
