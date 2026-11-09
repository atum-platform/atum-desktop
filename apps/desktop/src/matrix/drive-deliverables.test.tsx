import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { DESKTOP_LOCALES } from '../../shared/desktop-locale'
import type { MatrixDriveBridge, MatrixDriveView } from '../../shared/matrix-drive'

import { MatrixDrive } from './drive'
import { matrixDriveCopy } from './drive-copy'

afterEach(cleanup)

test.each(DESKTOP_LOCALES)(
  'a broker-full projection renders through the existing %s Drive screen without a retention promise',
  async locale => {
    const original: MatrixDriveView = {
      state: 'ready',
      revision: 2,
      canGoBack: false,
      truncated: false,
      rootLabel: 'Drive',
      rows: [{ id: 'file-handle', name: 'notes.txt', kind: 'file', size: 4, modifiedAt: 0 }],
      issues: [{ id: 'conflict-handle', code: 'conflicts', count: 1 }]
    }

    const id = '01234567-1234-1234-1234-012345678901'

    // Native projection is proved in its real filesystem/broker suite. Exercise its typed
    // presentation result here; renderer code never imports a native filesystem module.
    const view: MatrixDriveView = { ...original, issues: [...original.issues!, { id, code: 'drive_full', count: 1 }] }

    const reveal = vi.fn(async () => {})
    const bridge = { read: async () => view, subscribe: () => () => {}, reveal } as unknown as MatrixDriveBridge

    const rendered = render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <MatrixDrive bridge={bridge} />
      </I18nProvider>
    )

    const copy = matrixDriveCopy[locale]
    await screen.findByText(copy.facts.issues.drive_full.title)
    expect(screen.getByText(copy.facts.issues.conflicts.title)).toBeTruthy()
    expect(screen.queryByText(id)).toBeNull()
    expect(rendered.container.textContent).not.toMatch(/7 days|7 ngày|kept for|được giữ/iu)
    fireEvent.click(screen.getAllByRole('button', { name: copy.reveal })[0])
    await waitFor(() => expect(reveal).toHaveBeenCalledWith())
    expect(original.issues).toEqual([{ id: 'conflict-handle', code: 'conflicts', count: 1 }])
  }
)
