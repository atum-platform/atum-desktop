/**
 * The words of an agent's desk, the side panel's own tab in an agent's chat (plan "The agent's
 * side panel, rebuilt for cloud-only" §2.5). Short, one phone line each, in the app's voice.
 * Vietnamese is the default; every locale changes together.
 */
import type { DesktopLocale } from './desktop-locale'

export interface MatrixAgentDeskCopy {
  /** The desk's region, for screen readers: "Luna's desk". */
  desk: (name: string) => string
  free: string
  working: string
  waiting: string
  /** "On your MacBook Pro": the device it is using right now, by its owner-visible name. */
  onDevice: (device: string) => string
  /** The device line when the agent works on this Mac but no name is known. */
  onThisMac: string
  /** How long the state has lasted, after a dot: "4 min". */
  minutes: (count: number) => string
  stop: string
  /** Under Working when a message changes what it does (the composer steers the turn). */
  steerHint: string
  /** Under Working when a message waits for the turn instead (the cloud path today). */
  queueHint: string
  /** The ask's heading: "Luna needs your answer". */
  ask: (name: string) => string
  devices: string
  /** A device row's line while the agent is using it. */
  usingNow: string
  files: string
  openDrive: string
  /** The composer while the agent works and a message steers it. */
  composerSteer: (name: string) => string
}

export const matrixAgentDeskCopy: Record<DesktopLocale, MatrixAgentDeskCopy> = {
  vi: {
    desk: name => `Bàn làm việc của ${name}`,
    free: 'Rảnh',
    working: 'Đang làm',
    waiting: 'Chờ bạn',
    onDevice: device => `Trên ${device}`,
    onThisMac: 'Trên máy Mac này',
    minutes: count => `${count} phút`,
    stop: 'Dừng',
    steerHint: 'Nhắn trong trò chuyện để đổi việc nó đang làm.',
    queueHint: 'Tin nhắn mới sẽ chờ đến khi xong việc này.',
    ask: name => `${name} cần bạn trả lời`,
    devices: 'Thiết bị của bạn',
    usingNow: 'Đang dùng',
    files: 'Tệp',
    openDrive: 'Mở trong Drive',
    composerSteer: name => `Bảo ${name} đổi gì…`
  },
  en: {
    desk: name => `${name}’s desk`,
    free: 'Free',
    working: 'Working',
    waiting: 'Waiting for you',
    onDevice: device => `On your ${device}`,
    onThisMac: 'On this Mac',
    minutes: count => `${count} min`,
    stop: 'Stop',
    steerHint: 'Type in the chat to change what it’s doing.',
    queueHint: 'New messages wait until this is done.',
    ask: name => `${name} needs your answer`,
    devices: 'Your devices',
    usingNow: 'Using it now',
    files: 'Files',
    openDrive: 'Open in Drive',
    composerSteer: name => `Tell ${name} what to change…`
  },
  ja: {
    desk: name => `${name}のデスク`,
    free: '待機中',
    working: '作業中',
    waiting: 'あなたを待っています',
    onDevice: device => `${device}で作業中`,
    onThisMac: 'このMacで作業中',
    minutes: count => `${count}分`,
    stop: '停止',
    steerHint: 'チャットに書くと、今の作業を変えられます。',
    queueHint: '新しいメッセージはこの作業のあとに届きます。',
    ask: name => `${name}があなたの返事を待っています`,
    devices: 'あなたのデバイス',
    usingNow: '使用中',
    files: 'ファイル',
    openDrive: 'Driveで開く',
    composerSteer: name => `${name}に変えてほしいことを伝える…`
  },
  zh: {
    desk: name => `${name} 的工作台`,
    free: '空闲',
    working: '工作中',
    waiting: '等你回复',
    onDevice: device => `在你的 ${device} 上`,
    onThisMac: '在这台 Mac 上',
    minutes: count => `${count} 分钟`,
    stop: '停止',
    steerHint: '在聊天里说一声，就能改变它正在做的事。',
    queueHint: '新消息会等这件事做完。',
    ask: name => `${name} 需要你回答`,
    devices: '你的设备',
    usingNow: '正在使用',
    files: '文件',
    openDrive: '在 Drive 中打开',
    composerSteer: name => `告诉 ${name} 要改什么…`
  },
  'zh-hant': {
    desk: name => `${name} 的工作台`,
    free: '空閒',
    working: '工作中',
    waiting: '等你回覆',
    onDevice: device => `在你的 ${device} 上`,
    onThisMac: '在這台 Mac 上',
    minutes: count => `${count} 分鐘`,
    stop: '停止',
    steerHint: '在聊天裡說一聲，就能改變它正在做的事。',
    queueHint: '新訊息會等這件事做完。',
    ask: name => `${name} 需要你回答`,
    devices: '你的裝置',
    usingNow: '正在使用',
    files: '檔案',
    openDrive: '在 Drive 中開啟',
    composerSteer: name => `告訴 ${name} 要改什麼…`
  }
}

export function matrixAgentDeskText(locale: DesktopLocale): MatrixAgentDeskCopy {
  return matrixAgentDeskCopy[locale] ?? matrixAgentDeskCopy.vi
}
