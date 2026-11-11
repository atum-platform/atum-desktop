import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { DesktopLocale } from '../../shared/desktop-locale'
import type { MatrixAgentView, MatrixCloudAccess, MatrixUiBridge } from '../../shared/matrix'
import { matrixAgentStatusCopy } from '../../shared/matrix-agent-status-copy'
import { matrixFundsCopy } from '../../shared/matrix-funds-copy'

import { matrixAgentAccessEnded } from './cloud-access'
import { MatrixCloudAccessBand } from './cloud-status'
import { $fundsTopUp, closeFundsTopUp, registerFundsTopUpHost } from './funds/top-up-request'

const agent: MatrixAgentView = {
  principal: 'agent',
  userId: '@agent:test',
  ready: false,
  isDefault: true,
  hermes: 'unavailable',
  atumModel: true,
  answering: 'cloud'
}

const copy = matrixAgentStatusCopy.vi
const funds = matrixFundsCopy('vi')

const page = (children: React.ReactNode, locale: DesktopLocale = 'vi') => (
  <I18nProvider configClient={null} initialLocale={locale}>
    {children}
  </I18nProvider>
)

function bridge(access: MatrixCloudAccess | Promise<MatrixCloudAccess>) {
  const cloudAgent = vi.fn(async () => access)
  Object.assign(window, { atumMatrix: { cloudAgent } as unknown as MatrixUiBridge })

  return cloudAgent
}

afterEach(() => {
  closeFundsTopUp()
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('the cloud access band', () => {
  it.each(['trial_not_accepted', 'paid_lapsed', 'no_offer', 'entitlement_required', 'trial_expired'] as const)(
    'says Protons ran out in one line whose one button tops up in place (%s)',
    async reason => {
      bridge({ effective: 'none', reason })
      const unregister = registerFundsTopUpHost()
      const view = render(page(<MatrixCloudAccessBand agent={agent} />))

      await waitFor(() => expect(view.getByText(funds.outOfProtonsPaused)).toBeTruthy())
      // Never the old "message the Atum team" remedy, and never a balance.
      expect(view.queryByText(copy.accessRemedy, { exact: false })).toBeNull()
      fireEvent.click(view.getByRole('button', { name: funds.addProtons }))
      expect($fundsTopUp.get()).toMatchObject({ nonce: expect.any(Number) })
      unregister()
    }
  )

  it.each(['en', 'ja', 'zh', 'zh-hant'] as const)('speaks the reader’s own language (%s)', async locale => {
    const words = matrixFundsCopy(locale)
    bridge({ effective: 'none', reason: 'trial_expired' })
    const view = render(page(<MatrixCloudAccessBand agent={agent} />, locale))

    await waitFor(() => expect(view.getByText(words.outOfProtonsPaused)).toBeTruthy())
    expect(view.getByRole('button', { name: words.addProtons })).toBeTruthy()
  })

  it.each(['trial', 'paid'] as const)('hides when access is fine (%s)', async effective => {
    const read = bridge({ effective })
    const view = render(page(<MatrixCloudAccessBand agent={agent} />))

    await waitFor(() => expect(read).toHaveBeenCalledWith({ action: 'cloudAccess' }))
    expect(view.queryByText(funds.outOfProtonsPaused)).toBeNull()
    expect(view.container.querySelector('[data-matrix-cloud-access]')).toBeNull()
  })

  it('never asks for or shows access in a Mac-run assistant', async () => {
    const read = bridge({ effective: 'none', reason: 'trial_expired' })
    const view = render(page(<MatrixCloudAccessBand agent={{ ...agent, macRole: 'answering' }} />))

    expect(read).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-matrix-cloud-access]')).toBeNull()

    const local = render(page(<MatrixCloudAccessBand agent={{ ...agent, answering: undefined }} />))
    expect(read).not.toHaveBeenCalled()
    expect(local.container.querySelector('[data-matrix-cloud-access]')).toBeNull()
  })

  it('keeps the band for a standby Mac: without access the platform hands it no term (0238)', async () => {
    const read = bridge({ effective: 'none', reason: 'trial_expired' })
    const view = render(page(<MatrixCloudAccessBand agent={{ ...agent, macRole: 'standby' }} />))

    await waitFor(() => expect(view.getByText(funds.outOfProtonsPaused)).toBeTruthy())
    expect(read).toHaveBeenCalledWith({ action: 'cloudAccess' })
  })

  it('names the access state only for a cloud assistant this Mac does not answer for', () => {
    expect(matrixAgentAccessEnded(agent, { effective: 'none', reason: 'trial_expired' })).toBe(true)
    expect(matrixAgentAccessEnded({ ...agent, macRole: 'standby' }, { effective: 'none' })).toBe(true)
    expect(matrixAgentAccessEnded(agent, { effective: 'trial' })).toBe(false)
    expect(matrixAgentAccessEnded({ ...agent, macRole: 'answering' }, { effective: 'none' })).toBe(false)
    expect(matrixAgentAccessEnded({ ...agent, answering: undefined }, { effective: 'none' })).toBe(false)
  })
})
