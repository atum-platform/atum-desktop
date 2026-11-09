import { type Locale } from '@/i18n'

import { MatrixOwnerDeviceRepairNotice, type OwnerDeviceRepairSnapshot } from './owner-device-repair-notice'

interface DeviceHealthCopy {
  /** {n}: free space in GB. */
  diskLow: (n: string) => string
  diskCritical: (n: string) => string
  diskFullTitle: string
  diskFullBody: string
  openStorage: string
}

const copies: Record<Locale, DeviceHealthCopy> = {
  en: {
    diskLow: n =>
      `Your Mac is almost full (${n} GB free). Free up at least 10 GB so Atum can keep encrypted data safe.`,
    diskCritical: n =>
      `Your Mac is nearly out of space (${n} GB free). Messages and assistants may stop working until you free up at least 10 GB.`,
    diskFullTitle: "This Mac's disk is full",
    diskFullBody: 'Free up space and Atum reconnects on its own.',
    openStorage: 'Open Storage settings'
  },
  vi: {
    diskLow: n => `Mac sắp đầy (còn ${n} GB). Hãy giải phóng ít nhất 10 GB để Atum giữ an toàn dữ liệu mã hóa.`,
    diskCritical: n =>
      `Mac gần như hết dung lượng (còn ${n} GB). Tin nhắn và trợ lý có thể ngừng hoạt động cho đến khi bạn giải phóng ít nhất 10 GB.`,
    diskFullTitle: 'Ổ đĩa của máy Mac này đã đầy',
    diskFullBody: 'Giải phóng dung lượng và Atum sẽ tự kết nối lại.',
    openStorage: 'Mở Quản lý dung lượng'
  },
  ja: {
    diskLow: n =>
      `Mac の空き容量が少なくなっています（残り ${n} GB）。暗号化データを安全に保つため、10 GB 以上の空きを作ってください。`,
    diskCritical: n =>
      `Mac の空き容量がほとんどありません（残り ${n} GB）。10 GB 以上空けるまで、メッセージやアシスタントが動かなくなることがあります。`,
    diskFullTitle: 'この Mac のディスクがいっぱいです',
    diskFullBody: '空き容量を増やすと、Atum が自動的に再接続します。',
    openStorage: 'ストレージ設定を開く'
  },
  zh: {
    diskLow: n => `这台 Mac 空间快满了（剩余 ${n} GB）。请至少腾出 10 GB，让 Atum 安全保存加密数据。`,
    diskCritical: n => `这台 Mac 空间几乎用完了（剩余 ${n} GB）。在腾出至少 10 GB 之前，消息和助手可能无法正常工作。`,
    diskFullTitle: '这台 Mac 的磁盘已满',
    diskFullBody: '腾出空间后，Atum 会自动重新连接。',
    openStorage: '打开存储空间设置'
  },
  'zh-hant': {
    diskLow: n => `這台 Mac 空間快滿了（剩餘 ${n} GB）。請至少騰出 10 GB，讓 Atum 安全保存加密資料。`,
    diskCritical: n => `這台 Mac 空間幾乎用完了（剩餘 ${n} GB）。在騰出至少 10 GB 之前，訊息和助理可能無法正常運作。`,
    diskFullTitle: '這台 Mac 的磁碟已滿',
    diskFullBody: '騰出空間後，Atum 會自動重新連線。',
    openStorage: '打開儲存空間設定'
  }
}

export function matrixDeviceHealthCopy(locale: Locale): DeviceHealthCopy {
  return copies[locale]
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function MatrixDeviceHealthNotice({ snapshot }: { snapshot: OwnerDeviceRepairSnapshot }) {
  return <MatrixOwnerDeviceRepairNotice snapshot={snapshot} />
}
