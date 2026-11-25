import type { Locale } from '@/i18n'

import type { AccountPlan } from '../../../shared/account-connections'

/** A plan's name is the maker's product name in every language. */
export const ACCOUNT_PLAN_NAMES: Record<AccountPlan, string> = {
  codex: 'ChatGPT',
  claude: 'Claude',
  antigravity: 'Antigravity'
}

const MAKERS: Record<AccountPlan, string> = { codex: 'OpenAI', claude: 'Anthropic', antigravity: 'Google' }

export interface ConnectionsWords {
  /** Settings › Connections section titles. */
  subscriptions: string
  dataAndTools: string
  /** One row's one line. */
  onMacs(names: string): string
  lastSeen(names: string): string
  notConnected: string
  inCloud: string
  needsAttention: string
  thisMac: string
  connect: string
  manage: string
  ownerChats: { title: string; line: string }
  homeTools: { line: string }
  /** The connect sheet: Ask, then the Work title band's Finish / Done. */
  sheet: {
    title(plan: AccountPlan): string
    line(plan: AccountPlan): string
    /** Q1: the one sentence that is the consent. No checkbox. */
    consent: string
    continue: string
    notNow: string
    /** A device without Work (no T3 here) cannot hold the login. */
    needsMac: string
    close: string
  }
  progress: {
    signingIn(plan: AccountPlan): string
    done(plan: AccountPlan): string
    failed(plan: AccountPlan): string
    tryAgain: string
  }
  picker: {
    use(plan: AccountPlan): string
    /** A connected plan cloud assistants cannot reach yet: its models are greyed with this one line. */
    inWork: string
    openWork: string
  }
  mac: { label: string; help: string; otherHelp: string }
}

const en: ConnectionsWords = {
  subscriptions: 'Subscriptions',
  dataAndTools: 'Data and tools',
  onMacs: names => `On ${names}`,
  lastSeen: names => `Last seen on ${names}`,
  notConnected: 'Not connected',
  inCloud: 'In the cloud',
  needsAttention: 'Sign in again',
  thisMac: 'this Mac',
  connect: 'Connect',
  manage: 'Manage',
  ownerChats: { title: 'Your chats', line: 'Every assistant knows your chats.' },
  homeTools: { line: 'Every assistant can use it.' },
  sheet: {
    title: plan => `Connect ${ACCOUNT_PLAN_NAMES[plan]}`,
    line: plan => `Sign in with ${MAKERS[plan]}. Atum never sees your login.`,
    consent: 'Your assistants can use this plan through this Mac.',
    continue: 'Continue',
    notNow: 'Not now',
    needsMac: 'Open Atum on your Mac to connect.',
    close: 'Close'
  },
  progress: {
    signingIn: plan => `Finish signing in to ${ACCOUNT_PLAN_NAMES[plan]}`,
    done: plan => `${ACCOUNT_PLAN_NAMES[plan]} is connected`,
    failed: plan => `${ACCOUNT_PLAN_NAMES[plan]} isn’t connected yet`,
    tryAgain: 'Try again'
  },
  picker: {
    use: plan => `Use your ${ACCOUNT_PLAN_NAMES[plan]} plan`,
    inWork: 'Works in Work for now',
    openWork: 'Open Work'
  },
  mac: {
    label: 'Assistants can use this Mac',
    help: 'Your plans, files and terminal here.',
    otherHelp: 'Turn off on that Mac.'
  }
}

const vi: ConnectionsWords = {
  subscriptions: 'Gói đăng ký',
  dataAndTools: 'Dữ liệu và công cụ',
  onMacs: names => `Trên ${names}`,
  lastSeen: names => `Lần cuối trên ${names}`,
  notConnected: 'Chưa kết nối',
  inCloud: 'Trên đám mây',
  needsAttention: 'Cần đăng nhập lại',
  thisMac: 'máy Mac này',
  connect: 'Kết nối',
  manage: 'Quản lý',
  ownerChats: { title: 'Cuộc trò chuyện của bạn', line: 'Mọi trợ lý đều biết các cuộc trò chuyện của bạn.' },
  homeTools: { line: 'Mọi trợ lý đều dùng được.' },
  sheet: {
    title: plan => `Kết nối ${ACCOUNT_PLAN_NAMES[plan]}`,
    line: plan => `Đăng nhập bằng ${MAKERS[plan]}. Atum không bao giờ thấy thông tin đăng nhập của bạn.`,
    consent: 'Trợ lý của bạn có thể dùng gói này qua máy Mac này.',
    continue: 'Tiếp tục',
    notNow: 'Để sau',
    needsMac: 'Mở Atum trên máy Mac để kết nối.',
    close: 'Đóng'
  },
  progress: {
    signingIn: plan => `Hoàn tất đăng nhập ${ACCOUNT_PLAN_NAMES[plan]}`,
    done: plan => `Đã kết nối ${ACCOUNT_PLAN_NAMES[plan]}`,
    failed: plan => `Chưa kết nối được ${ACCOUNT_PLAN_NAMES[plan]}`,
    tryAgain: 'Thử lại'
  },
  picker: {
    use: plan => `Dùng gói ${ACCOUNT_PLAN_NAMES[plan]} của bạn`,
    inWork: 'Hiện chỉ dùng trong Work',
    openWork: 'Mở Work'
  },
  mac: {
    label: 'Trợ lý có thể dùng máy Mac này',
    help: 'Các gói, tệp và terminal ở đây.',
    otherHelp: 'Tắt trên máy Mac đó.'
  }
}

/** English and Vietnamese; the other UI languages read English until their lines are written. */
export function connectionsCopy(locale: Locale): ConnectionsWords {
  return locale === 'vi' ? vi : en
}
