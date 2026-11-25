import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { type Locale, useI18n } from '@/i18n'

import { MatrixOwnerDeviceRepairNotice, type OwnerDeviceRepairSnapshot } from './owner-device-repair-notice'

interface DeviceHealthCopy {
  diskFullTitle: string
  diskFullBody: string
  openStorage: string
  accessRepairBody: string
  accessRepairAction: string
  accessRepairBusy: string
  accessRepairFailed: string
}

const copies: Record<Locale, DeviceHealthCopy> = {
  en: {
    diskFullTitle: "This Mac's disk is full",
    diskFullBody: 'Free up space and Atum reconnects on its own.',
    openStorage: 'Open Storage settings',
    accessRepairBody: 'This Mac’s access needs repair. Cloud chat keeps working.',
    accessRepairAction: 'Repair this Mac',
    accessRepairBusy: 'Repairing…',
    accessRepairFailed: 'Repair didn’t finish. Try again.'
  },
  vi: {
    diskFullTitle: 'Ổ đĩa của máy Mac này đã đầy',
    diskFullBody: 'Giải phóng dung lượng và Atum sẽ tự kết nối lại.',
    openStorage: 'Mở Quản lý dung lượng',
    accessRepairBody: 'Quyền truy cập của máy Mac này cần được sửa. Trò chuyện trên đám mây vẫn hoạt động.',
    accessRepairAction: 'Sửa máy Mac này',
    accessRepairBusy: 'Đang sửa…',
    accessRepairFailed: 'Chưa sửa xong. Hãy thử lại.'
  },
  ja: {
    diskFullTitle: 'この Mac のディスクがいっぱいです',
    diskFullBody: '空き容量を増やすと、Atum が自動的に再接続します。',
    openStorage: 'ストレージ設定を開く',
    accessRepairBody: 'この Mac のアクセスを修復する必要があります。クラウドのチャットは引き続き使えます。',
    accessRepairAction: 'この Mac を修復',
    accessRepairBusy: '修復中…',
    accessRepairFailed: '修復が完了しませんでした。もう一度お試しください。'
  },
  zh: {
    diskFullTitle: '这台 Mac 的磁盘已满',
    diskFullBody: '腾出空间后，Atum 会自动重新连接。',
    openStorage: '打开存储空间设置',
    accessRepairBody: '这台 Mac 的访问需要修复。云端聊天仍可正常使用。',
    accessRepairAction: '修复这台 Mac',
    accessRepairBusy: '正在修复…',
    accessRepairFailed: '修复未完成，请重试。'
  },
  'zh-hant': {
    diskFullTitle: '這台 Mac 的磁碟已滿',
    diskFullBody: '騰出空間後，Atum 會自動重新連線。',
    openStorage: '打開儲存空間設定',
    accessRepairBody: '這台 Mac 的存取需要修復。雲端聊天仍可正常使用。',
    accessRepairAction: '修復這台 Mac',
    accessRepairBusy: '正在修復…',
    accessRepairFailed: '修復未完成，請重試。'
  }
}

export function matrixDeviceHealthCopy(locale: Locale): DeviceHealthCopy {
  return copies[locale]
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function MatrixDeviceHealthNotice({ snapshot }: { snapshot: OwnerDeviceRepairSnapshot & { deviceAccessRepair?: boolean } }) {
  const words = copies[useI18n().locale]
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const repair = () => {
    setBusy(true)
    setFailed(false)
    void Promise.resolve(window.atumMatrix?.repairDeviceAccess?.())
      .catch(() => setFailed(true))
      .finally(() => setBusy(false))
  }

  return (
    <>
      <MatrixOwnerDeviceRepairNotice snapshot={snapshot} />
      {snapshot.deviceAccessRepair && (
        <NoticeBand role="status" tone="notice">
          <div className="flex flex-col gap-1.5" data-matrix-device-access-repair>
            <p>{words.accessRepairBody}</p>
            {failed && <p role="alert">{words.accessRepairFailed}</p>}
            <span className="flex flex-wrap gap-2">
              <Button aria-busy={busy || undefined} disabled={busy} onClick={repair} size="sm" variant="secondary">
                {busy ? words.accessRepairBusy : words.accessRepairAction}
              </Button>
            </span>
          </div>
        </NoticeBand>
      )}
    </>
  )
}
