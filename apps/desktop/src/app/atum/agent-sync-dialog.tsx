import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'

import { $atumAgentSync, refreshAgentSync } from './agent-sync'
import type { AtumAgent } from './agents'
import { UTILITY_COPY } from './utilities/copy'

interface AtumAgentSyncDialogProps {
  agent: AtumAgent | null
  onClose: () => void
}

export function AtumAgentSyncDialog({ agent, onClose }: AtumAgentSyncDialogProps) {
  const { locale } = useI18n()
  const vi = locale === 'vi'
  const statuses = useStore($atumAgentSync)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(false)
  const id = agent?.hostedId
  const status = statuses.find(row => row.assistantId === id)
  useEffect(() => {
    setFailure(false)
    void refreshAgentSync().catch(() => setFailure(true))
  }, [id])

  const run = async (operation: () => Promise<void> | undefined) => {
    setBusy(true)
    setFailure(false)

    try {
      await operation()
      await refreshAgentSync()
    } catch {
      setFailure(true)
    } finally {
      setBusy(false)
    }
  }

  const labels = vi
    ? {
        synced: 'Đã đồng bộ',
        pending: 'Đang chờ đồng bộ',
        conflict: 'Có thay đổi trên hai máy',
        error: 'Chưa đồng bộ được',
        disabled: 'Đã tạm dừng',
        local_only: 'Chỉ trên máy này'
      }
    : {
        synced: 'Synced',
        pending: 'Waiting to sync',
        conflict: 'Changed on two computers',
        error: 'Could not sync',
        disabled: 'Paused',
        local_only: 'Only on this computer'
      }

  return (
    <Dialog
      onOpenChange={open => {
        if (!open) {onClose()}
      }}
      open={Boolean(agent)}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{vi ? 'Đồng bộ trợ lý' : 'Agent sync'}</DialogTitle>
          <DialogDescription>{agent?.title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-5 text-sm">
          {status?.workspaceProtected && (
            <p className="text-xs text-(--atum-ink-muted)">{UTILITY_COPY[locale].workspaceLocalOnly}</p>
          )}
          {(['skills', 'memory'] as const).map(kind => (
            <div className="space-y-2" key={kind}>
              <div className="flex items-center justify-between gap-4">
                <span className="font-medium">
                  {kind === 'skills'
                    ? vi
                      ? 'Kỹ năng và thiết lập'
                      : 'Skills and settings'
                    : vi
                      ? 'Trí nhớ'
                      : 'Memory'}
                </span>
                <span className="text-(--atum-ink-muted)">
                  {status ? labels[status[kind]] : vi ? 'Đang kiểm tra…' : 'Checking…'}
                </span>
              </div>
              {kind === 'memory' && !status?.workspaceProtected && (
                <>
                  <label className="flex items-center gap-2">
                    <Switch
                      aria-label={vi ? 'Đồng bộ trí nhớ trên các máy Mac' : 'Sync desktop memory between Macs'}
                      checked={status?.memoryEnabled ?? false}
                      disabled={busy || !status || !id || status.memory === 'local_only'}
                      onCheckedChange={enabled => {
                        void run(() =>
                          id ? window.hermesDesktop?.agentSync?.setMemoryEnabled(id, enabled) : undefined
                        )
                      }}
                    />
                    {vi ? 'Đồng bộ trí nhớ trên các máy Mac' : 'Sync desktop memory between Macs'}
                  </label>
                  {!status?.workspaceProtected && <p className="text-xs text-(--atum-ink-muted)">
                    {vi
                      ? 'Đồng bộ bản ghi nhớ của hồ sơ trên máy tính qua tài khoản của bạn. Nhà riêng và lịch sử phiên của trợ lý chạy trên cloud được giữ riêng.'
                      : 'Syncs this desktop profile’s memory snapshot through your account. A running cloud agent keeps a separate private home and session history.'}
                  </p>}
                </>
              )}
              {status?.[kind] === 'conflict' && (
                <div className="space-y-2">
                  <p className="text-xs text-(--atum-ink-muted)">
                    {vi
                      ? 'Hai phiên bản đang được giữ lại. Chọn bản bạn muốn dùng để tiếp tục đồng bộ.'
                      : 'Both versions are preserved. Choose the version to use to resume syncing.'}
                  </p>
                  <div className="flex gap-2">
                    {(['local', 'cloud'] as const).map(choice => (
                      <Button
                        disabled={busy}
                        key={choice}
                        onClick={() =>
                          void run(() => (id ? window.hermesDesktop?.agentSync?.resolve(id, kind, choice) : undefined))
                        }
                        size="sm"
                        variant="outline"
                      >
                        {choice === 'local'
                          ? vi
                            ? 'Dùng bản trên máy này'
                            : 'Use this computer'
                          : vi
                            ? 'Dùng bản trong tài khoản'
                            : 'Use account copy'}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
          <div className="flex items-center justify-between gap-4">
            <span className="font-medium">{vi ? 'Thú cưng' : 'Pets'}</span>
            <span className="text-(--atum-ink-muted)">
              {status?.pets === 'unavailable'
                ? vi ? 'Một số thú cưng chưa thể đồng bộ' : 'Some pets could not sync'
                : status?.pets ? labels[status.pets] : vi ? 'Đang kiểm tra…' : 'Checking…'}
            </span>
          </div>
          {failure && (
            <NoticeBand role="alert">
              {vi ? 'Chưa thể đồng bộ. Hãy thử lại.' : 'Could not sync. Please try again.'}
            </NoticeBand>
          )}
          <Button
            disabled={busy || !id}
            onClick={() => void run(() => window.hermesDesktop?.agentSync?.sync())}
            variant="outline"
          >
            {busy ? (vi ? 'Đang đồng bộ…' : 'Syncing…') : vi ? 'Đồng bộ ngay' : 'Sync now'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
