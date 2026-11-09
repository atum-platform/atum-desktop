import '@xterm/xterm/css/xterm.css'

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import { makeTerminalReader } from '@/app/right-sidebar/terminal/buffer'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'
import type { MatrixTerminalTab, TerminalReadOptions, TerminalReadResult } from '../../shared/matrix-terminal'

const copies = {
  en: { open: (ordinal: number) => `View running task (${ordinal})`, help: 'View only. Closing this tab won’t stop the task.', unavailable: 'This task can no longer be shown.' },
  vi: { open: (ordinal: number) => `Xem tiến trình đang chạy (${ordinal})`, help: 'Chỉ để xem. Đóng thẻ không dừng tác vụ.', unavailable: 'Không còn xem được tác vụ này.' },
  zh: { open: (ordinal: number) => `查看正在运行的任务（${ordinal}）`, help: '仅供查看。关闭此标签页不会停止任务。', unavailable: '此任务已无法显示。' },
  'zh-hant': { open: (ordinal: number) => `查看執行中的任務（${ordinal}）`, help: '僅供檢視。關閉此分頁不會停止任務。', unavailable: '此任務已無法顯示。' },
  ja: { open: (ordinal: number) => `実行中のタスクを見る（${ordinal}）`, help: '表示のみです。タブを閉じてもタスクは止まりません。', unavailable: 'このタスクはもう表示できません。' }
}

type Reader = (options: TerminalReadOptions) => Promise<TerminalReadResult>
const readers = new Map<string, Reader>()

export function useMatrixTerminalCopy() {
  const { locale } = useI18n()

  return copies[locale] ?? copies.en
}

/** Uses only this Matrix xterm's buffer; never the legacy active terminal store. */
export function MatrixTerminalPane({ tab, roomId, scope, active }: {
  tab: MatrixTerminalTab
  roomId: string
  scope: string
  active: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const fit = useRef<FitAddon | null>(null)
  const c = useMatrixTerminalCopy()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const bridge = window.atumMatrix.terminals
    const node = host.current

    if (!bridge || !node) {
      setFailed(true)

      return
    }

    let alive = true
    let sequence = -1
    let reloading = false
    let wantedSequence = -1

    const term = new Terminal({ disableStdin: true, convertEol: true, cursorBlink: false,
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace", fontSize: 11, scrollback: 1000 })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(node)
    fit.current = fitAddon

    const refit = () => {
      if (node.clientWidth && node.clientHeight) {
        try { fitAddon.fit() } catch { /* The next resize refits a transitioning view. */ }
      }
    }

    const observer = new ResizeObserver(refit)
    observer.observe(node)
    refit()

    const reader: Reader = options => new Promise((resolve, reject) => {
      // Drain queued ANSI parsing before reading visible cells.
      term.write('', () => alive ? resolve(makeTerminalReader(term)(options)) : reject(new Error('retired')))
    })

    readers.set(`${scope}\0${tab.id}`, reader)

    const reload = async () => {
      if (reloading || !alive) { return }
      reloading = true

      try {
        do {
          const data = await bridge.read(roomId, tab.id)

          if (!alive || data.scope !== scope || data.id !== tab.id) { return }

          if (data.sequence >= sequence) {
            sequence = data.sequence
            term.reset()
            term.write(data.output)
            setFailed(false)
          }
        } while (alive && sequence < wantedSequence)
      } catch {
        if (alive) { setFailed(true) }
      } finally {
        reloading = false
      }
    }

    const unsubscribe = bridge.subscribe(value => {
      if (!alive || value.id !== tab.id || value.scope !== scope || value.sequence <= sequence) { return }
      wantedSequence = Math.max(wantedSequence, value.sequence)

      if (sequence < 0 || reloading || value.sequence !== sequence + 1) {
        void reload()

        return
      }

      sequence = value.sequence
      term.write(value.chunk)
    })

    void reload()

    return () => {
      alive = false
      unsubscribe()
      observer.disconnect()

      if (readers.get(`${scope}\0${tab.id}`) === reader) { readers.delete(`${scope}\0${tab.id}`) }
      term.dispose()
      fit.current = null
    }
  }, [tab.id, roomId, scope])

  useEffect(() => {
    if (active) {
      const frame = requestAnimationFrame(() => {
        try { fit.current?.fit() } catch { /* A hidden window refits on resize. */ }
      })

      return () => cancelAnimationFrame(frame)
    }
  }, [active])

  return <div className="flex h-full min-h-0 flex-col" data-matrix-terminal>
    <p className="shrink-0 border-b border-(--atum-line) px-4 py-2 text-xs text-(--atum-ink-muted)">{c.help}</p>
    {failed && <NoticeBand>{c.unavailable}</NoticeBand>}
    <div className="min-h-0 flex-1 p-2" ref={host} />
  </div>
}

export function MatrixTerminalOffers({ snapshot, scope, onOpened }: {
  snapshot: MatrixSnapshot
  scope: string
  onOpened(id: string, scope: string): void
}) {
  const c = useMatrixTerminalCopy()
  const [pending, setPending] = useState<string>()
  const [failed, setFailed] = useState(false)
  const generation = useRef({ scope, serial: 0 })

  if (generation.current.scope !== scope) { generation.current = { scope, serial: generation.current.serial + 1 } }
  useEffect(() => { setPending(undefined); setFailed(false) }, [scope])
  useEffect(() => () => { generation.current.serial += 1 }, [])
  const bridge = window.atumMatrix.terminals

  if (!snapshot.roomId || !snapshot.terminals?.length || !bridge) { return null }

  return <div className="flex flex-wrap items-center gap-2 pb-2" data-matrix-terminal-offers>
    {snapshot.terminals.map(tab => <Button disabled={Boolean(pending)} key={tab.id} onClick={() => {
        const serial = generation.current.serial
        setPending(tab.id)
        setFailed(false)
        void bridge.open(snapshot.roomId!, tab.id).then(() => {
          if (generation.current.serial === serial) { onOpened(tab.id, scope) }
        }).catch(() => { if (generation.current.serial === serial) { setFailed(true) } })
          .finally(() => { if (generation.current.serial === serial) { setPending(undefined) } })
      }} size="sm"
      variant="secondary">{c.open(tab.ordinal)}</Button>)}
    {failed && <NoticeBand>{c.unavailable}</NoticeBand>}
  </div>
}

/** Respond only while the exact room's selected terminal is visible. */
export function useMatrixTerminalRead(snapshot: MatrixSnapshot, scope: string, selectedId: string | null, visible: boolean) {
  const request = snapshot.terminalRead
  const binding = useRef<{ id: string; scope: string; selectedId: string | null } | undefined>(undefined)

  if (request && binding.current?.id !== request.id) {
    binding.current = { id: request.id, scope, selectedId }
  }

  useEffect(() => {
    if (!request || !snapshot.roomId || !window.atumMatrix.terminals) { return }
    let alive = true
    const bridge = window.atumMatrix.terminals
    const reader = visible && binding.current?.scope === scope && binding.current.selectedId === selectedId && selectedId ? readers.get(`${scope}\0${selectedId}`) : undefined
    void Promise.resolve().then(() => reader?.(request)).catch(() => null).then(result => {
      if (alive) { return bridge.respond(snapshot.roomId!, request.id, result ?? null) }
    }).catch(() => {})

    return () => { alive = false }
  }, [request, scope, selectedId, visible, snapshot.roomId])
}
