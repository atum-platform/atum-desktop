import { type KeyboardEvent, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Loader } from '@/components/ui/loader'
import { SearchField } from '@/components/ui/search-field'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Check, File, Share } from '@/lib/icons'

import type { MatrixMessage } from '../../shared/matrix'

import { useChatCopy } from './chat-copy'
import { focusDialogField, MatrixDialogHeader } from './dialog-header'
import { filterMatrixForwardTargets, type MatrixForwardTarget } from './forward-targets'
import { MatrixPersonAvatar } from './member-avatar'

type SendState = 'idle' | 'sending' | 'sent' | 'failed'

const forwardDialogNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), value =>
  value.toString(16).padStart(2, '0')).join('')

export function MatrixForwardDialog({
  onOpenChange,
  onSend,
  open,
  source,
  sourceName,
  targets,
  teamName
}: {
  onOpenChange(open: boolean): void
  onSend(target: MatrixForwardTarget, dialogNonce: string): Promise<void>
  open: boolean
  source: MatrixMessage
  sourceName: string
  targets: readonly MatrixForwardTarget[]
  teamName?: string
}) {
  const copy = useChatCopy()
  const { locale } = useI18n()
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(0)
  const [states, setStates] = useState<Record<string, SendState>>({})
  const nonce = useRef(forwardDialogNonce())
  const visible = useMemo(() => filterMatrixForwardTargets(targets, query), [query, targets])

  const send = async (target: MatrixForwardTarget) => {
    if (target.disabled || states[target.room.id] === 'sending' || states[target.room.id] === 'sent') {
      return
    }

    setStates(value => ({ ...value, [target.room.id]: 'sending' }))
    try {
      await onSend(target, nonce.current)
      setStates(value => ({ ...value, [target.room.id]: 'sent' }))
    } catch {
      setStates(value => ({ ...value, [target.room.id]: 'failed' }))
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!visible.length || !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
      return
    }

    event.preventDefault()
    if (event.key === 'Enter') {
      const target = visible[Math.min(focused, visible.length - 1)]
      if (target) {
        void send(target)
      }
    } else {
      const step = event.key === 'ArrowDown' ? 1 : -1
      setFocused(value => (value + step + visible.length) % visible.length)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="max-w-[26.25rem] gap-3"
        data-matrix-forward-dialog
        onKeyDown={onKeyDown}
        onOpenAutoFocus={focusDialogField}
        showCloseButton={false}
      >
        <MatrixDialogHeader title={copy.forwardTitle} />
        <div className="rounded-(--atum-r-card) border border-(--atum-line) bg-(--atum-row-hover) p-3" data-matrix-forward-preview>
          <p className="text-xs font-semibold text-(--atum-ink-muted)">{sourceName}</p>
          {source.attachment ? (
            <p className="mt-1 flex items-center gap-2 text-sm text-(--atum-ink)">
              <File aria-hidden className="size-4" />
              <span className="truncate">{source.body}</span>
              {source.attachmentSize !== undefined && (
                <span className="shrink-0 text-xs text-(--atum-ink-muted)">
                  · {new Intl.NumberFormat(locale, { style: 'unit', unit: 'byte', notation: 'compact' }).format(source.attachmentSize)}
                </span>
              )}
            </p>
          ) : (
            <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-(--atum-ink)">{source.body}</p>
          )}
        </div>
        <SearchField
          aria-label={copy.forwardSearch}
          onChange={value => {
            setQuery(value)
            setFocused(0)
          }}
          placeholder={copy.forwardSearch}
          value={query}
        />
        {teamName && <p className="text-xs text-(--atum-ink-muted)">{copy.forwardTeamOnly(teamName)}</p>}
        <div className="max-h-[60vh] overflow-y-auto" role="listbox">
          {visible.length ? visible.map((target, index) => {
            const state = states[target.room.id] ?? 'idle'
            const button = (
              <Button
                aria-label={copy.forwardSendTo(target.name)}
                disabled={Boolean(target.disabled) || state === 'sending' || state === 'sent'}
                onClick={() => void send(target)}
                size="sm"
                type="button"
                variant="secondary"
              >
                {state === 'sending' ? <Loader size="sm" /> : state === 'sent' ? <Check aria-hidden /> : <Share aria-hidden />}
                {state === 'sent' ? copy.sent : state === 'failed' ? copy.retry : copy.forwardSend}
              </Button>
            )

            return (
              <div
                aria-selected={index === focused}
                className="flex items-center gap-3 rounded-(--atum-r-control) px-2 py-2 aria-selected:bg-(--atum-row-hover)"
                data-forward-target={target.room.id}
                key={target.room.id}
                onMouseEnter={() => setFocused(index)}
                role="option"
              >
                <MatrixPersonAvatar
                  agent={target.assistant}
                  avatarMxc={target.room.peerAvatarMxc}
                  className="size-9 shrink-0 rounded-[0.65rem] text-xs"
                  id={target.avatarUserId ?? target.room.id}
                  name={target.name}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-(--atum-ink)">{target.name}</span>
                  {target.subtitle && <span className="block truncate text-xs text-(--atum-ink-muted)">{target.subtitle}</span>}
                </span>
                {target.disabled ? <Tip label={copy.forwardEncryptedOnly}><span>{button}</span></Tip> : button}
              </div>
            )
          }) : (
            <p className="grid min-h-28 place-items-center text-sm text-(--atum-ink-muted)">{copy.forwardEmpty}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
