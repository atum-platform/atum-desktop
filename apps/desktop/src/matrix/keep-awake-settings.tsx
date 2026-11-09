import { useEffect, useRef, useState } from 'react'

import { NoticeBand } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { type Locale, useI18n } from '@/i18n'

import type { MatrixKeepAwakeBridge } from '../../shared/matrix-keep-awake'

import { SettingsRow } from './settings-row'

interface KeepAwakeCopy {
  title: string
  description: string
  failed: string
}

const COPY: Record<Locale, KeepAwakeCopy> = {
  en: {
    title: 'Keep this Mac awake for Atum',
    description:
      "While this Mac is plugged in and Atum is open, it won't fall asleep on its own, so your assistants can keep working with it. The display still turns off and locks as usual. Closing a MacBook's lid still puts it to sleep.",
    failed: 'Could not change the keep-awake setting.'
  },
  vi: {
    title: 'Giữ máy Mac thức cho Atum',
    description:
      'Khi máy Mac này đang cắm nguồn và Atum đang mở, máy sẽ không tự ngủ để trợ lý vẫn làm việc được với máy. Màn hình vẫn tắt và khoá như thường. Gập nắp MacBook thì máy vẫn ngủ.',
    failed: 'Chưa thay đổi được thiết lập giữ máy thức.'
  },
  ja: {
    title: 'この Mac を Atum のためにスリープさせない',
    description:
      'この Mac が電源に接続され、Atum が開いている間は自動的にスリープせず、アシスタントが使い続けられます。画面の消灯とロックは通常どおりで、MacBook のふたを閉じるとスリープします。',
    failed: 'スリープさせない設定を変更できませんでした。'
  },
  zh: {
    title: '让这台 Mac 为 Atum 保持唤醒',
    description:
      '当这台 Mac 接通电源且 Atum 处于打开状态时，它不会自动睡眠，助手可以继续使用它。屏幕仍会正常关闭和锁定；合上 MacBook 仍会使其睡眠。',
    failed: '无法更改保持唤醒设置。'
  },
  'zh-hant': {
    title: '讓這台 Mac 為 Atum 保持喚醒',
    description:
      '當這台 Mac 接上電源且 Atum 開啟時，它不會自動睡眠，助理可以繼續使用它。螢幕仍會正常關閉和鎖定；闔上 MacBook 仍會使其睡眠。',
    failed: '無法更改保持喚醒設定。'
  }
}

/** The one per-Mac switch over listening, cloud-device reach-down and the future failover chain. */
export function MatrixKeepAwakeSettings({
  bridge = window.atumKeepAwake
}: {
  bridge?: MatrixKeepAwakeBridge
}) {
  const { locale } = useI18n()
  const words = COPY[locale]
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    void bridge?.status().then(
      value => {
        if (mounted.current) {
          setEnabled(value)
          setFailed(false)
        }
      },
      () => {
        if (mounted.current) {
          setFailed(true)
        }
      }
    )

    return () => {
      mounted.current = false
    }
  }, [bridge])

  const change = async (next: boolean) => {
    if (!bridge || enabled === null || pending) {
      return
    }

    setPending(true)
    setFailed(false)

    try {
      const actual = await bridge.setEnabled(next)

      if (mounted.current) {
        setEnabled(actual)
      }
    } catch {
      if (mounted.current) {
        setFailed(true)
      }
    } finally {
      if (mounted.current) {
        setPending(false)
      }
    }
  }

  if (!bridge) {
    return null
  }

  return (
    <div data-matrix-keep-awake>
      <SettingsRow
        as="label"
        control={
          <Switch
            aria-label={words.title}
            checked={enabled ?? false}
            disabled={enabled === null || pending}
            onCheckedChange={value => void change(value)}
          />
        }
        help={words.description}
        title={words.title}
      />
      {failed && (
        <NoticeBand role="status" tone="notice">
          {words.failed}
        </NoticeBand>
      )}
    </div>
  )
}
