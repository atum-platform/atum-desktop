import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { MATRIX_DECRYPTION_REASONS, matrixDecryptionAction } from '../../shared/matrix-decryption-reason'

import { matrixChatCopy } from './chat-copy'
import { MatrixUndecryptableMessage } from './undecryptable-message'

afterEach(cleanup)

it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'])('shows every closed reason and only its correct action in %s', locale => {
  for (const reason of MATRIX_DECRYPTION_REASONS) {
    for (const backupAvailable of [false, true]) {
      const callbacks = {
        devices: vi.fn(),
        verify: vi.fn(),
        review: vi.fn(),
        restore: vi.fn()
      }

      const view = render(
        <MatrixUndecryptableMessage
          backupAvailable={backupAvailable}
          locale={locale}
          onDevices={callbacks.devices}
          onRestore={callbacks.restore}
          onReview={callbacks.review}
          onVerify={callbacks.verify}
          reason={reason}
        />
      )

      const copy = matrixChatCopy(locale).decryption
      expect(screen.getByText(copy.reasons[reason])).toBeTruthy()
      const action = matrixDecryptionAction(reason, backupAvailable)

      if (action === 'none') {
        expect(screen.queryByRole('button')).toBeNull()
      } else {
        fireEvent.click(screen.getByRole('button', { name: copy.actions[action] }))
        expect(callbacks[action]).toHaveBeenCalledTimes(1)
        expect(Object.values(callbacks).filter(fn => fn.mock.calls.length)).toHaveLength(1)
      }

      expect(view.container.textContent).not.toMatch(/MEGOLM_|HISTORICAL_MESSAGE_|\$event|@sender:test|private message/)
      view.unmount()
    }
  }
})

it('uses only a display name for changed-identity copy and never enables trust itself', () => {
  render(
    <MatrixUndecryptableMessage
      backupAvailable={false}
      locale="en"
      reason="sender_identity_changed"
      senderName="Linh"
    />
  )
  expect(screen.getByText(matrixChatCopy('en').decryption.identityChanged('Linh'))).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

it('keeps translated copy when the message has no name', () => {
  for (const locale of ['vi', 'ja', 'zh', 'zh-hant']) {
    const copy = matrixChatCopy(locale).decryption

    for (const reason of MATRIX_DECRYPTION_REASONS) {
      expect(copy.reasons[reason]).not.toBe(matrixChatCopy('en').decryption.reasons[reason])
    }
  }
})
