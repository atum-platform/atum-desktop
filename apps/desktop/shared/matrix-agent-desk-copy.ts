/**
 * The words of an agent's desk, the side panel's own tab in an agent's chat (plan "The agent's
 * side panel, rebuilt for cloud-only" §2.5). Short, one phone line each, in the app's voice.
 * Vietnamese is the default; every locale changes together.
 */
import type { DesktopLocale } from './desktop-locale'

export interface MatrixAgentDeskCopy {
  /** The desk's region, for screen readers: "Luna's desk". */
  desk: (name: string) => string
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
  /** Now's head while a native cron turn runs (its marker says `trigger: 'cron'`). */
  routine: string
  /** Files' tooltip: they are the files the agent sent in this chat (Matrix file events). */
  sentHere: string
  /** A sent file's Save button, for screen readers: "Save Q4 plan.docx". */
  save: (name: string) => string
  /** The visible word on that button. */
  saveShort: string
  /** The folded steps: "2 of 3 done". */
  stepsDone: (done: number, total: number) => string
  /** Opens clamped agent text in place, and folds it again. */
  more: string
  less: string
  /** Files › its own files on its cloud computer (the host desk route). */
  onItsComputer: string
  /** Back out of a folder of its computer. */
  back: string
  controls: string
  /** This chat's notifications (the chat's own mute). */
  notifications: string
  /** The one disclosure for rarely used controls. */
  moreControls: string
  /** Its routines, as the host reads its native schedule. */
  routines: string
  /** A paused routine's state word. */
  paused: string
  /** A routine's next run: "Next: Fri 08:00". */
  nextRun: (when: string) => string
  /** Opens the agent's card, where every other setting lives. */
  allSettings: string
  /** On the chat's working line: open the side panel on the agent's own tab. */
  watch: string
}

export const matrixAgentDeskCopy: Record<DesktopLocale, MatrixAgentDeskCopy> = {
  vi: {
    desk: name => `Bàn làm việc của ${name}`,
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
    composerSteer: name => `Bảo ${name} đổi gì…`,
    routine: 'Đang chạy việc định kỳ',
    sentHere: 'Gửi trong trò chuyện này',
    save: name => `Lưu ${name}`,
    saveShort: 'Lưu',
    stepsDone: (done, total) => `Xong ${done}/${total}`,
    more: 'Xem thêm',
    less: 'Thu gọn',
    onItsComputer: 'Trên máy của nó',
    back: 'Quay lại',
    controls: 'Điều khiển',
    notifications: 'Thông báo',
    moreControls: 'Thêm',
    routines: 'Việc định kỳ',
    paused: 'Tạm dừng',
    nextRun: when => `Lần tới: ${when}`,
    allSettings: 'Tất cả cài đặt',
    watch: 'Xem'
  },
  en: {
    desk: name => `${name}’s desk`,
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
    composerSteer: name => `Tell ${name} what to change…`,
    routine: 'Running a routine',
    sentHere: 'Sent in this chat',
    save: name => `Save ${name}`,
    saveShort: 'Save',
    stepsDone: (done, total) => `${done} of ${total} done`,
    more: 'Show more',
    less: 'Show less',
    onItsComputer: 'On its computer',
    back: 'Back',
    controls: 'Controls',
    notifications: 'Notifications',
    moreControls: 'More',
    routines: 'Routines',
    paused: 'Paused',
    nextRun: when => `Next: ${when}`,
    allSettings: 'All settings',
    watch: 'Watch'
  },
  ja: {
    desk: name => `${name}のデスク`,
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
    composerSteer: name => `${name}に変えてほしいことを伝える…`,
    routine: '定期タスクを実行中',
    sentHere: 'このチャットで送信',
    save: name => `${name}を保存`,
    saveShort: '保存',
    stepsDone: (done, total) => `${total}件中${done}件完了`,
    more: '続きを表示',
    less: '閉じる',
    onItsComputer: 'エージェントのコンピュータ',
    back: '戻る',
    controls: '操作',
    notifications: '通知',
    moreControls: 'その他',
    routines: '定期タスク',
    paused: '一時停止中',
    nextRun: when => `次回: ${when}`,
    allSettings: 'すべての設定',
    watch: '見る'
  },
  zh: {
    desk: name => `${name} 的工作台`,
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
    composerSteer: name => `告诉 ${name} 要改什么…`,
    routine: '正在执行例行任务',
    sentHere: '在此聊天中发送',
    save: name => `保存 ${name}`,
    saveShort: '保存',
    stepsDone: (done, total) => `已完成 ${done}/${total}`,
    more: '更多',
    less: '收起',
    onItsComputer: '在它的电脑上',
    back: '返回',
    controls: '控制',
    notifications: '通知',
    moreControls: '更多设置',
    routines: '例行任务',
    paused: '已暂停',
    nextRun: when => `下次：${when}`,
    allSettings: '全部设置',
    watch: '查看'
  },
  'zh-hant': {
    desk: name => `${name} 的工作台`,
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
    composerSteer: name => `告訴 ${name} 要改什麼…`,
    routine: '正在執行例行任務',
    sentHere: '在此聊天中傳送',
    save: name => `儲存 ${name}`,
    saveShort: '儲存',
    stepsDone: (done, total) => `已完成 ${done}/${total}`,
    more: '更多',
    less: '收起',
    onItsComputer: '在它的電腦上',
    back: '返回',
    controls: '控制',
    notifications: '通知',
    moreControls: '更多設定',
    routines: '例行任務',
    paused: '已暫停',
    nextRun: when => `下次：${when}`,
    allSettings: '全部設定',
    watch: '查看'
  }
}

export function matrixAgentDeskText(locale: DesktopLocale): MatrixAgentDeskCopy {
  return matrixAgentDeskCopy[locale] ?? matrixAgentDeskCopy.vi
}
