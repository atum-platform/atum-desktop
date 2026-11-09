import { useState } from 'react'

import { Button } from '@/components/ui/button'
import type { Locale } from '@/i18n'

import type { MatrixNewSignIn } from '../../shared/matrix'

/** The platforms an Atum app names itself after ("Atum for iPhone"), in a sentence. */
type Platform = 'iphone' | 'ipad' | 'mac' | 'android' | 'windows' | 'computer'

export interface MatrixNewSignInCopy {
  /** The title bar's tip and the line in the popover's list: which device, in a few words. */
  label(device: string): string
  /** The popover's one line: the same, and the question. */
  question(device: string): string
  /** The question alone, under the label in a list of several. */
  ask: string
  /** "Yes, that was me": the notice goes away for that device. */
  itWasMe: string
  /** Opens the sign-in server's sign-out step for that one device. */
  signOut: string
  /** The sign-out step did not open (offline, no such page): the notice stays. */
  failed: string
  /** When nothing readable is known about the device. */
  generic: string
  platforms: Record<Platform, string>
}

export const MATRIX_NEW_SIGN_IN_COPY: Record<Locale, MatrixNewSignInCopy> = {
  en: {
    label: device => `New sign-in on ${device}`,
    question: device => `New sign-in on ${device}. Was this you?`,
    ask: 'Was this you?',
    itWasMe: 'It was me',
    signOut: 'Sign it out',
    failed: 'Couldn’t open the sign-out page. Try again.',
    generic: 'another device',
    platforms: {
      iphone: 'an iPhone',
      ipad: 'an iPad',
      mac: 'a Mac',
      android: 'an Android phone',
      windows: 'a Windows PC',
      computer: 'a computer'
    }
  },
  vi: {
    label: device => `Đăng nhập mới trên ${device}`,
    question: device => `Đăng nhập mới trên ${device}. Có phải bạn không?`,
    ask: 'Có phải bạn không?',
    itWasMe: 'Là tôi',
    signOut: 'Đăng xuất thiết bị đó',
    failed: 'Chưa mở được trang đăng xuất. Hãy thử lại.',
    generic: 'một thiết bị khác',
    platforms: {
      iphone: 'một iPhone',
      ipad: 'một iPad',
      mac: 'một máy Mac',
      android: 'một điện thoại Android',
      windows: 'một máy tính Windows',
      computer: 'một máy tính'
    }
  },
  ja: {
    label: device => `${device}で新しいサインイン`,
    question: device => `${device}で新しいサインインがありました。あなたですか？`,
    ask: 'あなたですか？',
    itWasMe: '自分です',
    signOut: 'サインアウトさせる',
    failed: 'サインアウトのページを開けませんでした。もう一度お試しください。',
    generic: '別のデバイス',
    platforms: {
      iphone: 'iPhone',
      ipad: 'iPad',
      mac: 'Mac',
      android: 'Android スマートフォン',
      windows: 'Windows PC',
      computer: 'パソコン'
    }
  },
  zh: {
    label: device => `${device}上有新的登录`,
    question: device => `${device}上有新的登录。是你本人吗？`,
    ask: '是你本人吗？',
    itWasMe: '是我',
    signOut: '让它退出登录',
    failed: '无法打开退出登录页面，请重试。',
    generic: '其他设备',
    platforms: {
      iphone: 'iPhone',
      ipad: 'iPad',
      mac: 'Mac',
      android: 'Android 手机',
      windows: 'Windows 电脑',
      computer: '电脑'
    }
  },
  'zh-hant': {
    label: device => `${device}上有新的登入`,
    question: device => `${device}上有新的登入。是你本人嗎？`,
    ask: '是你本人嗎？',
    itWasMe: '是我',
    signOut: '讓它登出',
    failed: '無法開啟登出頁面，請再試一次。',
    generic: '其他裝置',
    platforms: {
      iphone: 'iPhone',
      ipad: 'iPad',
      mac: 'Mac',
      android: 'Android 手機',
      windows: 'Windows 電腦',
      computer: '電腦'
    }
  }
}

/** "Atum for iPhone", "Atum for Mac", …: the client names Atum's own apps sign in with. */
const ATUM_CLIENT = /^atum for (iphone|ipad|mac|macos|android|windows|desktop)\b/i

const ATUM_PLATFORM: Record<string, Platform> = {
  iphone: 'iphone',
  ipad: 'ipad',
  mac: 'mac',
  macos: 'mac',
  android: 'android',
  windows: 'windows',
  desktop: 'computer'
}

/** The sign-in server names a session "<client> on <device>" and says "Unknown device" when the
 * device's own software doesn't tell it; that half carries nothing for the person. */
const UNKNOWN_DEVICE = /\s+on\s+unknown device\s*$/i

const MAX_NAME = 40

/**
 * The device, in words the person reads in one glance: an Atum app by its platform ("an iPhone"),
 * any other name as the device itself calls itself (never the server's "Unknown device", never a
 * raw device ID), else "another device".
 */
export function matrixNewSignInDevice(name: string | undefined, locale: Locale): string {
  const copy = MATRIX_NEW_SIGN_IN_COPY[locale]
  const own = (name ?? '').replace(UNKNOWN_DEVICE, '').trim()
  const atum = ATUM_CLIENT.exec(own)

  if (atum) {
    return copy.platforms[ATUM_PLATFORM[atum[1]!.toLowerCase()] ?? 'computer']
  }

  if (!own || /^unknown device$/i.test(own)) {
    return copy.generic
  }

  return own.length > MAX_NAME ? `${own.slice(0, MAX_NAME - 1).trimEnd()}…` : own
}

export function matrixNewSignInLabel(view: MatrixNewSignIn, locale: Locale): string {
  return MATRIX_NEW_SIGN_IN_COPY[locale].label(matrixNewSignInDevice(view.name, locale))
}

export interface MatrixNewSignInDetailProps {
  /** Under its own label (the indicator's list of several): only the question. */
  headed?: boolean
  locale: Locale
  view: MatrixNewSignIn
  /** "It was me": accounts for that device in main, persisted across restarts. */
  onDismiss: (deviceId: string) => Promise<void>
  /** Opens the sign-in server's sign-out step for that one device, in the browser. */
  onSignOut: (deviceId: string) => Promise<void>
}

/**
 * A new sign-in to this account on another device (G13), inside the title bar's attention popover
 * (agent-attention.ts): one line and two answers. It never sits in the page, so nothing under the
 * title bar moves. The action opens the sign-in server's step for ending that device's session (the
 * same opener the security panel uses; Matrix's own device delete needs the sign-in server here).
 */
export function MatrixNewSignInDetail({ headed, locale, view, onDismiss, onSignOut }: MatrixNewSignInDetailProps) {
  const copy = MATRIX_NEW_SIGN_IN_COPY[locale]
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  const run = (action: () => Promise<void>) => {
    setPending(true)
    setFailed(false)
    void Promise.resolve()
      .then(action)
      .catch(() => setFailed(true))
      .finally(() => setPending(false))
  }

  return (
    <div className="flex flex-col gap-2 p-1.5 text-(length:--atum-t-ui)" data-matrix-new-sign-in>
      <p>{headed ? copy.ask : copy.question(matrixNewSignInDevice(view.name, locale))}</p>
      {failed && <p role="alert">{copy.failed}</p>}
      <span className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={() => run(() => onDismiss(view.deviceId))} size="sm" variant="secondary">
          {copy.itWasMe}
        </Button>
        <Button disabled={pending} onClick={() => run(() => onSignOut(view.deviceId))} size="sm" variant="text">
          {copy.signOut}
        </Button>
      </span>
    </div>
  )
}
