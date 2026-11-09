import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { ExternalLink } from '@/lib/icons'

import { atumMailLink } from '../../shared/atum-company'
import type { MatrixSnapshot } from '../../shared/matrix'

import { ATUM_LINKS } from './atum-links'
import { useMatrixCopy } from './copy'
import { useMatrixLegalCopy } from './legal-copy'
import { SettingsLinkRow, SettingsSection } from './settings-row'

/**
 * Settings › Help › Legal, the pane's last section: the published Terms of Service and
 * Privacy Policy on atumplatform.com, then the source code of the bundled Atum Drive engine
 * (GPL), each a row that opens in the browser (↗); last, the open-source licences that ship with
 * the app, which open in a window of the app (›).
 */
export function MatrixLegalSettings() {
  const legal = useMatrixLegalCopy()

  const pages = [
    { label: legal.terms, url: ATUM_LINKS.terms },
    { label: legal.privacy, url: ATUM_LINKS.privacy },
    { label: legal.driveEngineSource, url: ATUM_LINKS.driveEngineSource }
  ]

  return (
    <SettingsSection data-matrix-legal-settings title={legal.legal}>
      {pages.map(page => (
        <SettingsLinkRow
          key={page.url}
          onClick={() => void window.atumMatrix.openLink(page.url).catch(() => {})}
          trailing={<ExternalLink aria-hidden className="atum-settings-chevron" />}
        >
          {page.label}
        </SettingsLinkRow>
      ))}
      <SettingsLinkRow
        data-matrix-open-source-licences
        onClick={() => void window.atumMatrix.openSourceNotices?.(legal.openSourceLicences).catch(() => {})}
      >
        {legal.openSourceLicences}
      </SettingsLinkRow>
    </SettingsSection>
  )
}

/**
 * Settings › Account, after Sign out: deleting the account is a request by email to Atum's
 * privacy mailbox, done by hand within 30 days (the Privacy Policy). The one action opens a
 * draft in the mail app, its subject and the person's Atum ID filled in; the address stays
 * on screen for anyone whose email lives in a browser, and says so again if no mail app
 * opened.
 */
export function MatrixDeleteAccount({ snapshot }: { snapshot: MatrixSnapshot }) {
  const legal = useMatrixLegalCopy()
  const copy = useMatrixCopy()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const userId = snapshot.identity?.userId

  const request = () => {
    const body = userId ? `${legal.deleteAccountBody}\n\n${copy.userId}: ${userId}` : legal.deleteAccountBody

    setFailed(false)
    void window.atumMatrix
      .openLink(atumMailLink('privacy', legal.deleteAccountSubject, body))
      .then(() => setOpen(false))
      .catch(() => setFailed(true))
  }

  return (
    <>
      <Button data-matrix-delete-account onClick={() => setOpen(true)} size="sm" variant="text">
        {legal.deleteAccountAction}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="ak-dialog max-w-none border-0" showCloseButton={false}>
          <DialogTitle className="ak-dialog-title">{legal.deleteAccountDialogTitle}</DialogTitle>
          <DialogDescription className="ak-dialog-body">{legal.deleteAccountDialogBody}</DialogDescription>
          {failed && (
            <NoticeBand role="status" tone="notice">
              {legal.deleteAccountFailed}
            </NoticeBand>
          )}
          <div className="ak-dialog-actions">
            <button className="ak-btn" onClick={() => setOpen(false)} type="button">
              {t.common.cancel}
            </button>
            <button className="ak-btn ak-btn--danger" onClick={request} type="button">
              {legal.deleteAccountConfirm}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
