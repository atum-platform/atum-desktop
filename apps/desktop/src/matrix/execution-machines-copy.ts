import type {
  ExecutionDestinationReason,
  ExecutionDestinationState,
  ExecutionDestinationView,
  ExecutionDeviceName,
  ExecutionPolicyDestinationView
} from '../../shared/execution-policy'

import { executionDeviceRealName } from './execution-device-name'

export type ExecutionMachinesLocale = 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant'

interface ExecutionMachinesWords {
  group: string
  cloud: string
  mac: (ordinal: number) => string
  /** Appended to this Mac's real name (§9.4): "MacBook Air (this Mac)". */
  thisMac: string
  state: Record<ExecutionDestinationState, string>
  reason: Record<ExecutionDestinationReason, string>
  /** A Mac held for an entitlement lapse (0238): it waits for the plan, it is not broken. */
  waitingForPlan: string
}

const words: Record<ExecutionMachinesLocale, ExecutionMachinesWords> = {
  en: {
    group: 'Where this assistant can answer',
    waitingForPlan: 'Waiting for the plan',
    cloud: 'Cloud',
    mac: ordinal => `Mac ${ordinal}`,
    thisMac: '(this Mac)',
    state: {
      ready: 'Ready',
      working: 'Working',
      busy: 'Busy',
      yielding: 'Switching',
      offline: 'Offline',
      disabled: 'Off',
      degraded: 'Needs attention'
    },
    reason: {
      busy: 'Busy',
      higher_priority: 'Switching to a higher-priority destination',
      not_present: 'Not online',
      locked: 'Locked',
      stale: 'Not responding',
      owner_disabled: 'Turned off',
      server_down: 'Server unavailable',
      upgrade_required: 'Update required',
      model_incompatible: 'Model unavailable here',
      data_incompatible: 'Data unavailable here',
      entitlement_required: 'Plan required',
      consent_required: 'Permission required',
      execution_failed: "Couldn't run"
    }
  },
  vi: {
    group: 'Nơi trợ lý này có thể trả lời',
    waitingForPlan: 'Đang chờ gói dịch vụ',
    cloud: 'Đám mây',
    mac: ordinal => `Máy Mac ${ordinal}`,
    thisMac: '(máy này)',
    state: {
      ready: 'Sẵn sàng',
      working: 'Đang làm việc',
      busy: 'Đang bận',
      yielding: 'Đang chuyển',
      offline: 'Ngoại tuyến',
      disabled: 'Đã tắt',
      degraded: 'Cần chú ý'
    },
    reason: {
      busy: 'Đang bận',
      higher_priority: 'Đang chuyển sang nơi ưu tiên cao hơn',
      not_present: 'Chưa trực tuyến',
      locked: 'Đang khóa',
      stale: 'Không phản hồi',
      owner_disabled: 'Đã tắt',
      server_down: 'Máy chủ chưa sẵn sàng',
      upgrade_required: 'Cần cập nhật',
      model_incompatible: 'Mô hình không dùng được ở đây',
      data_incompatible: 'Dữ liệu không dùng được ở đây',
      entitlement_required: 'Cần gói phù hợp',
      consent_required: 'Cần cho phép',
      execution_failed: 'Không chạy được'
    }
  },
  ja: {
    group: 'このアシスタントが応答できる場所',
    waitingForPlan: 'プランの更新待ち',
    cloud: 'クラウド',
    mac: ordinal => `Mac ${ordinal}`,
    thisMac: '(このMac)',
    state: {
      ready: '準備完了',
      working: '作業中',
      busy: '使用中',
      yielding: '切り替え中',
      offline: 'オフライン',
      disabled: 'オフ',
      degraded: '確認が必要'
    },
    reason: {
      busy: '使用中',
      higher_priority: '優先度の高い場所へ切り替え中',
      not_present: 'オンラインではありません',
      locked: 'ロック中',
      stale: '応答がありません',
      owner_disabled: 'オフになっています',
      server_down: 'サーバーを利用できません',
      upgrade_required: '更新が必要です',
      model_incompatible: 'この場所ではモデルを利用できません',
      data_incompatible: 'この場所ではデータを利用できません',
      entitlement_required: 'プランが必要です',
      consent_required: '許可が必要です',
      execution_failed: '実行できませんでした'
    }
  },
  zh: {
    group: '此助手可以回复的位置',
    waitingForPlan: '等待套餐恢复',
    cloud: '云端',
    mac: ordinal => `Mac ${ordinal}`,
    thisMac: '(这台 Mac)',
    state: {
      ready: '就绪',
      working: '工作中',
      busy: '忙碌',
      yielding: '正在切换',
      offline: '离线',
      disabled: '已关闭',
      degraded: '需要处理'
    },
    reason: {
      busy: '忙碌',
      higher_priority: '正在切换到优先级更高的位置',
      not_present: '未在线',
      locked: '已锁定',
      stale: '无响应',
      owner_disabled: '已关闭',
      server_down: '服务器不可用',
      upgrade_required: '需要更新',
      model_incompatible: '此处无法使用该模型',
      data_incompatible: '此处无法使用该数据',
      entitlement_required: '需要相应方案',
      consent_required: '需要许可',
      execution_failed: '无法运行'
    }
  },
  'zh-hant': {
    group: '此助理可以回覆的位置',
    waitingForPlan: '等待方案恢復',
    cloud: '雲端',
    mac: ordinal => `Mac ${ordinal}`,
    thisMac: '(這台 Mac)',
    state: {
      ready: '就緒',
      working: '工作中',
      busy: '忙碌',
      yielding: '正在切換',
      offline: '離線',
      disabled: '已關閉',
      degraded: '需要處理'
    },
    reason: {
      busy: '忙碌',
      higher_priority: '正在切換到優先級較高的位置',
      not_present: '未在線上',
      locked: '已鎖定',
      stale: '沒有回應',
      owner_disabled: '已關閉',
      server_down: '伺服器無法使用',
      upgrade_required: '需要更新',
      model_incompatible: '此處無法使用該模型',
      data_incompatible: '此處無法使用該資料',
      entitlement_required: '需要相應方案',
      consent_required: '需要許可',
      execution_failed: '無法執行'
    }
  }
}

export function executionMachinesCopy(locale: string): ExecutionMachinesWords {
  return Object.hasOwn(words, locale) ? words[locale as ExecutionMachinesLocale] : words.en
}

/**
 * The name a destination row and the closed trigger speak (§9.4 "Real names"): the owner's
 * name for the Mac when main has it ("MacBook Air"), the model when that name says nothing,
 * the stable ordinal otherwise ("Máy Mac 2"). Only this Mac carries the "(máy này)" suffix.
 */
export function executionMachineName(
  locale: string,
  view: ExecutionPolicyDestinationView,
  deviceNames?: Record<string, ExecutionDeviceName>
): string {
  const copy = executionMachinesCopy(locale)

  if (view.kind === 'cloud') {
    return copy.cloud
  }

  const device = view.id.startsWith('mac:') ? deviceNames?.[view.id.slice('mac:'.length)] : undefined
  const name = device ? executionDeviceRealName(device) : undefined

  if (device && name) {
    return device.thisMac ? `${name} ${copy.thisMac}` : name
  }

  return copy.mac(view.macOrdinal ?? 1)
}

/** A Mac whose agent is held for an entitlement lapse (0238): it is waiting for the plan, not
 * broken. The cloud's own `entitlement_required` stays the plain "plan required". */
export function executionMachineWaitsForPlan(view: ExecutionDestinationView): boolean {
  return view.kind === 'mac' && view.state === 'degraded' && view.reason === 'entitlement_required'
}

export function executionMachineStateLabel(locale: string, view: ExecutionDestinationView): string {
  const copy = executionMachinesCopy(locale)

  if (executionMachineWaitsForPlan(view)) {
    return copy.waitingForPlan
  }

  return view.reason ? copy.reason[view.reason] : copy.state[view.state]
}

export function executionMachineLabel(locale: string, view: ExecutionDestinationView): string {
  const destination = executionMachineName(locale, view)
  const state = executionMachineStateLabel(locale, view)

  return `${destination}: ${state}`
}
