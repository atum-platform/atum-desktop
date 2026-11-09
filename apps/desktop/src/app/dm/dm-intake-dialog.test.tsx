import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AppSurfaces from '@/lib/atum-app-surfaces'
import type { AppSurfaceResult, IntakeFieldSpec, IntakeStatus } from '@/lib/atum-app-surfaces'

type AppSurfaceModule = typeof AppSurfaces

const intakeStatus = vi.fn<() => Promise<AppSurfaceResult<IntakeStatus>>>()
const submitIntake = vi.fn<() => Promise<AppSurfaceResult<IntakeStatus>>>()

vi.mock('@/lib/atum-app-surfaces', async () => {
  const actual = await vi.importActual<AppSurfaceModule>('@/lib/atum-app-surfaces')

  return {
    ...actual,
    atumAppSurfaceClient: () => ({
      intakeStatus,
      submitIntake,
      connectStatus: vi.fn(),
      connectCandidate: vi.fn(),
      connectStart: vi.fn(),
      connectDismiss: vi.fn()
    })
  }
})

const { DmIntakeDialog } = await import('./dm-intake-dialog')

function field(name: string, overrides: Partial<IntakeFieldSpec> = {}): IntakeFieldSpec {
  return { name, type: 'text', label: null, placeholder: null, options: [], ...overrides }
}

const onComplete = vi.fn()
const onOpenChange = vi.fn()

function open() {
  return render(<DmIntakeDialog appId="moon" appName="Moon" onComplete={onComplete} onOpenChange={onOpenChange} open />)
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DmIntakeDialog', () => {
  it('renders one control per declared missing field, in server order', async () => {
    intakeStatus.mockResolvedValue({
      complete: false,
      fields: [field('preferred_name', { label: 'Tên bạn muốn được gọi' }), field('dob', { type: 'date' })]
    })
    open()

    const name = await screen.findByLabelText('Tên bạn muốn được gọi')

    expect((name as HTMLInputElement).type).toBe('text')
    // No label was declared for `dob`, so the field name is humanized rather
    // than printed raw — and nothing about Moon is hardcoded to produce it.
    expect((screen.getByLabelText('Dob') as HTMLInputElement).type).toBe('date')
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
  })

  it('renders a select only when the app declared options for it', async () => {
    intakeStatus.mockResolvedValue({
      complete: false,
      fields: [
        field('gender', {
          type: 'select',
          label: 'Giới tính',
          options: [
            { value: 'male', label: 'Nam' },
            { value: 'female', label: 'Nữ' }
          ]
        })
      ]
    })
    open()

    expect(await screen.findByRole('combobox', { name: 'Giới tính' })).toBeTruthy()
  })

  it('closes without a form when the app reports it needs nothing', async () => {
    // The app-that-declares-nothing case, seen from inside the dialog: even if
    // it is mounted, it must never show an empty form.
    intakeStatus.mockResolvedValue({ complete: true, fields: [] })
    open()

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('offers a retry instead of a broken form when the status cannot be loaded', async () => {
    intakeStatus.mockResolvedValue({ error: 'app_surface_unavailable' })
    open()

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The form could not be loaded. Check your connection and try again.'
    )

    intakeStatus.mockResolvedValue({ complete: false, fields: [field('dob')] })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByLabelText('Dob')).toBeTruthy()
  })

  it('refuses to submit a blank required field and says which one', async () => {
    intakeStatus.mockResolvedValue({ complete: false, fields: [field('dob'), field('birth_city')] })
    open()

    fireEvent.change(await screen.findByLabelText('Dob'), { target: { value: '1990-01-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))

    await waitFor(() => expect(screen.getByLabelText('Birth city').getAttribute('aria-invalid')).toBe('true'))
    expect(screen.getByLabelText('Dob').getAttribute('aria-invalid')).not.toBe('true')
    expect(submitIntake).not.toHaveBeenCalled()
  })

  it('submits exactly the declared fields and closes on completion', async () => {
    intakeStatus.mockResolvedValue({ complete: false, fields: [field('preferred_name')] })
    submitIntake.mockResolvedValue({ complete: true, fields: [] })
    open()

    fireEvent.change(await screen.findByLabelText('Preferred name'), { target: { value: '  Minh  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))

    await waitFor(() => expect(submitIntake).toHaveBeenCalledWith('moon', { preferred_name: 'Minh' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('attaches a field-addressed rejection to that control, never echoing the app text', async () => {
    intakeStatus.mockResolvedValue({ complete: false, fields: [field('dob')] })
    submitIntake.mockResolvedValue({ error: 'invalid_intake', field: 'dob' })
    open()

    fireEvent.change(await screen.findByLabelText('Dob'), { target: { value: 'nonsense' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))

    await waitFor(() => expect(screen.getByLabelText('Dob').getAttribute('aria-invalid')).toBe('true'))
    expect(screen.getByText('Choose a valid birth date.')).toBeTruthy()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('keeps Moon’s required birth-time helper attached to the field', async () => {
    intakeStatus.mockResolvedValue({ complete: false, fields: [field('birth_time', { type: 'time' })] })
    open()

    const input = await screen.findByLabelText('Birth time')
    const help = screen.getByText('An approximate time is okay.')

    expect(input.getAttribute('aria-describedby')).toContain(help.id)
  })

  it('re-renders from the app answer when a submission is accepted but still incomplete', async () => {
    intakeStatus.mockResolvedValue({ complete: false, fields: [field('dob')] })
    submitIntake.mockResolvedValue({ complete: false, fields: [field('birth_city')] })
    open()

    fireEvent.change(await screen.findByLabelText('Dob'), { target: { value: '1990-01-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))

    expect(await screen.findByLabelText('Birth city')).toBeTruthy()
    expect(screen.queryByLabelText('Dob')).toBeNull()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('does not touch the network while it is closed', () => {
    render(
      <DmIntakeDialog appId="moon" appName="Moon" onComplete={onComplete} onOpenChange={onOpenChange} open={false} />
    )

    expect(intakeStatus).not.toHaveBeenCalled()
  })
})
