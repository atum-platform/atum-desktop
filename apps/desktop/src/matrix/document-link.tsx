import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Tip } from '@/components/ui/tooltip'
import { type Locale, useI18n } from '@/i18n'
import { Info } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixSnapshot } from '../../shared/matrix'

import { runMatrixDocumentAction } from './text-document-actions'
import { matrixWordError } from './word-error'
import { useMatrixWorkbenchCopy } from './workbench-copy'

const en = {
  choose: 'Open a document…',
  change: 'Choose another document…',
  remove: 'Remove document',
  linked: 'Saved file',
  editableHelp: 'Changes save to this file automatically.',
  previewHelp: 'A read-only preview of the saved file.',
  unsupported: 'This file can’t be previewed.',
  reconnect: 'Choose this document again to keep using it.',
  unavailable: 'This document can’t be opened. Choose it again or remove it.',
  help: 'Your assistant reads the saved file each time you ask. The file itself isn’t uploaded to the chat.',
  error: 'Choose a file under 20 MB in your home folder.'
}

const copies: Record<Locale, typeof en> = {
  en,
  vi: {
    choose: 'Mở tài liệu…',
    change: 'Chọn tài liệu khác…',
    remove: 'Bỏ tài liệu',
    linked: 'Tệp đã lưu',
    editableHelp: 'Thay đổi được tự động lưu vào tệp này.',
    previewHelp: 'Bản xem chỉ đọc của tệp đã lưu.',
    unsupported: 'Chưa xem trước được tệp này.',
    reconnect: 'Chọn lại tài liệu này để tiếp tục dùng.',
    unavailable: 'Không mở được tài liệu này. Hãy chọn lại hoặc bỏ tài liệu.',
    help: 'Trợ lý đọc tệp đã lưu mỗi khi bạn hỏi. Tệp không được tải lên cuộc trò chuyện.',
    error: 'Chọn tệp nhỏ hơn 20 MB trong thư mục của bạn.'
  },
  ja: {
    choose: 'ドキュメントを開く…',
    change: '別のドキュメントを選ぶ…',
    remove: 'ドキュメントを外す',
    linked: '保存済みファイル',
    editableHelp: '変更はこのファイルに自動保存されます。',
    previewHelp: '保存済みファイルの読み取り専用プレビューです。',
    unsupported: 'このファイルはプレビューできません。',
    reconnect: '引き続き使うには、この文書を選び直してください。',
    unavailable: 'この文書を開けません。選び直すか外してください。',
    help: 'アシスタントは頼まれるたびに保存済みファイルを読みます。ファイル自体はチャットにアップロードされません。',
    error: 'ホームフォルダ内の 20 MB 未満のファイルを選んでください。'
  },
  zh: {
    choose: '打开文档…',
    change: '选择其他文档…',
    remove: '移除文档',
    linked: '已保存文件',
    editableHelp: '更改会自动保存到此文件。',
    previewHelp: '已保存文件的只读预览。',
    unsupported: '无法预览此文件。',
    reconnect: '请重新选择此文档以继续使用。',
    unavailable: '无法打开此文档。请重新选择或移除。',
    help: '每次你提问时，助手都会读取已保存的文件。文件本身不会上传到对话。',
    error: '请选择主文件夹中小于 20 MB 的文件。'
  },
  'zh-hant': {
    choose: '開啟文件…',
    change: '選擇其他文件…',
    remove: '移除文件',
    linked: '已儲存檔案',
    editableHelp: '變更會自動儲存到此檔案。',
    previewHelp: '已儲存檔案的唯讀預覽。',
    unsupported: '無法預覽此檔案。',
    reconnect: '請重新選擇此文件以繼續使用。',
    unavailable: '無法開啟此文件。請重新選擇或移除。',
    help: '每次你提問時，助理都會讀取已儲存的檔案。檔案本身不會上傳到對話。',
    error: '請選擇家目錄中小於 20 MB 的檔案。'
  }
}

/**
 * A document's state in one short chip — "Saves automatically", "View only" — with
 * the explanation one hover or Tab away, instead of a paragraph over every document.
 */
export function MatrixDocumentStatus({ detail, help, label }: { detail?: string; help: string; label: string }) {
  const workbench = useMatrixWorkbenchCopy()

  return (
    <span className="flex min-w-0 items-center gap-1.5" data-matrix-document-status>
      <span className="shrink-0 rounded-full bg-(--atum-sunk) px-2 py-0.5 text-(length:--atum-t-caption) font-medium text-(--atum-ink-soft)">
        {label}
      </span>
      {detail && <span className="shrink-0 text-(length:--atum-t-caption) text-(--atum-ink-muted)">{detail}</span>}
      <Tip label={help} side="bottom">
        <button aria-label={workbench.about} className="atum-icon-btn size-6 shrink-0" data-icon-only type="button">
          <Info aria-hidden className="size-3.5" />
        </button>
      </Tip>
    </span>
  )
}

/** Keyed by account/device + room by the caller: no late error crosses scope. */
export function useDocumentCopy() {
  const { locale } = useI18n()

  return copies[locale]
}

export function DocumentLink({
  className,
  snapshot,
  onPreview,
  statusOnly = false,
  disabled: externallyDisabled = false,
  onPendingChange
}: {
  /** Where it sits decides its inset (a dialog row starts at the dialog's edge). */
  className?: string
  snapshot: MatrixSnapshot
  onPreview?: () => void
  statusOnly?: boolean
  disabled?: boolean
  onPendingChange?: (pending: boolean) => void
}) {
  const { locale, t } = useI18n()
  const copy = copies[locale]
  const workbench = useMatrixWorkbenchCopy()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const link = snapshot.linkedDocument
  const disabled = externallyDisabled || pending || snapshot.state !== 'ready' || snapshot.hermes === 'running'

  const act = (action: 'choose' | 'remove') => {
    if (!snapshot.roomId) {
      return
    }

    setPending(true)
    onPendingChange?.(true)
    setError(null)
    const roomId = snapshot.roomId
    void runMatrixDocumentAction(() => window.atumMatrix.document(roomId, action))
      .catch(error => setError(matrixWordError(error, t.atum.workspace, copy.error)))
      .finally(() => {
        setPending(false)
        onPendingChange?.(false)
      })
  }

  return (
    <section aria-label={copy.choose} className={cn('px-4 py-2 text-xs', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {link?.name && (
          <span>
            {link.name} · {link.kind === 'word' ? t.atum.workspace.wordCompanionLabel : copy.linked}
          </span>
        )}
        {!statusOnly && (
          <Button disabled={disabled} onClick={() => act('choose')} size="sm" variant="text">
            {link ? copy.change : copy.choose}
          </Button>
        )}
        {!statusOnly && link && (
          <Button disabled={disabled} onClick={() => act('remove')} size="sm" variant="text">
            {copy.remove}
          </Button>
        )}
        {link?.state === 'linked' && onPreview && (
          <Button disabled={snapshot.state !== 'ready'} onClick={onPreview} size="sm" variant="text">
            {t.atum.workspace.filesOpen}
          </Button>
        )}
        {/* Above the chat the explanation is a hover away, not a standing paragraph. */}
        {link && statusOnly && (
          <Tip label={link.kind === 'word' ? t.atum.workspace.wordLiveContext : copy.help}>
            <button aria-label={workbench.about} className="atum-icon-btn size-6" data-icon-only type="button">
              <Info aria-hidden className="size-3.5" />
            </button>
          </Tip>
        )}
      </div>
      {link && !statusOnly && <p>{link.kind === 'word' ? t.atum.workspace.wordLiveContext : copy.help}</p>}
      {link && link.state !== 'linked' && (
        <NoticeBand tone="notice">{link.state === 'reconnect_required' ? copy.reconnect : copy.unavailable}</NoticeBand>
      )}
      {error && <NoticeBand tone="failure">{error}</NoticeBand>}
    </section>
  )
}
