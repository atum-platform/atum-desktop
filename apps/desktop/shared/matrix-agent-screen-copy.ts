/**
 * The words of an agent's Screen, the side panel tab where the owner watches the agent's own
 * cloud browser and takes over for a sign-in or a code (plan "Agent browser the owner can watch
 * and take over", 2026-11-28, step S4). One action and at most one line on screen at a time; no
 * jargon. Written once here so the phone's screen (S5) says the same. Every locale changes
 * together.
 */
import type { DesktopLocale } from './desktop-locale'

export interface MatrixAgentScreenCopy {
  /** The side panel tab's title. */
  tab: string
  /** The chip while the agent drives: "Luna is using the screen". */
  agentUsing: (name: string) => string
  /** The chip while this window holds control. */
  youControl: string
  /** The chip while a release is on its way to the server. */
  handingBack: string
  /** The chip when control is held by another window, or left open from before. */
  elsewhere: string
  takeOver: string
  /** One explicit action (owner D2): release, then one "carry on" message once it is confirmed. */
  handBackContinue: string
  /** Clears control left open by another window or an earlier session. */
  handBackForce: string
  handBackForceHint: string
  reconnect: string
  /** The one line under the screen. Names the browser so the owner knows it is not this Mac's. */
  watchLine: (name: string) => string
  controlLine: (name: string) => string
  connecting: string
  /** No screen running yet: it opens by itself when the agent starts browsing. */
  idle: (name: string) => string
  streamLost: string
  /** Another window took control; this one went back to watching. */
  controlMoved: string
  unavailable: string
  /** Only the agent's owner may watch or take over (owner D3). */
  ownerOnly: string
  /** The owner's visible message after "Hand back and continue". */
  continueMessage: string
}

const copy: Record<DesktopLocale, MatrixAgentScreenCopy> = {
  en: {
    tab: 'Screen',
    agentUsing: name => `${name} is using the screen`,
    youControl: "You're in control",
    handingBack: 'Handing back…',
    elsewhere: 'In control in another window',
    takeOver: 'Take over',
    handBackContinue: 'Hand back and continue',
    handBackForce: 'Hand back (force)',
    handBackForceHint: 'Ends control that was left open',
    reconnect: 'Reconnect',
    watchLine: name => `${name}'s browser in the cloud. Take over to sign in or type a code.`,
    controlLine: name => `${name} waits while you're in control.`,
    connecting: 'Connecting to the screen…',
    idle: name => `${name}'s screen opens here when it starts using the browser.`,
    streamLost: 'The screen stopped updating.',
    controlMoved: 'Control moved to another window.',
    unavailable: "The screen isn't available right now.",
    ownerOnly: 'Only the owner can see this screen.',
    continueMessage: 'Done, carry on.'
  },
  vi: {
    tab: 'Màn hình',
    agentUsing: name => `${name} đang dùng màn hình`,
    youControl: 'Bạn đang điều khiển',
    handingBack: 'Đang trả lại…',
    elsewhere: 'Đang điều khiển ở cửa sổ khác',
    takeOver: 'Điều khiển',
    handBackContinue: 'Trả lại và tiếp tục',
    handBackForce: 'Trả lại (buộc)',
    handBackForceHint: 'Kết thúc phiên điều khiển còn bỏ ngỏ',
    reconnect: 'Kết nối lại',
    watchLine: name => `Trình duyệt của ${name} trên đám mây. Bấm Điều khiển để đăng nhập hoặc nhập mã.`,
    controlLine: name => `${name} chờ trong lúc bạn điều khiển.`,
    connecting: 'Đang kết nối màn hình…',
    idle: name => `Màn hình của ${name} sẽ hiện ở đây khi bắt đầu dùng trình duyệt.`,
    streamLost: 'Màn hình đã ngừng cập nhật.',
    controlMoved: 'Quyền điều khiển đã chuyển sang cửa sổ khác.',
    unavailable: 'Màn hình hiện chưa dùng được.',
    ownerOnly: 'Chỉ chủ sở hữu mới xem được màn hình này.',
    continueMessage: 'Xong rồi, bạn làm tiếp nhé.'
  },
  ja: {
    tab: '画面',
    agentUsing: name => `${name}が画面を使っています`,
    youControl: '操作中です',
    handingBack: '戻しています…',
    elsewhere: '別のウィンドウで操作中',
    takeOver: '操作する',
    handBackContinue: '戻して続ける',
    handBackForce: '戻す（強制）',
    handBackForceHint: '開いたままの操作を終わらせます',
    reconnect: '再接続',
    watchLine: name => `クラウド上の${name}のブラウザです。サインインやコード入力は「操作する」から。`,
    controlLine: name => `操作中は${name}が待っています。`,
    connecting: '画面に接続しています…',
    idle: name => `${name}がブラウザを使い始めると、ここに画面が表示されます。`,
    streamLost: '画面の更新が止まりました。',
    controlMoved: '操作は別のウィンドウに移りました。',
    unavailable: '画面は今は使えません。',
    ownerOnly: 'この画面はオーナーだけが見られます。',
    continueMessage: '終わりました。続けてください。'
  },
  zh: {
    tab: '屏幕',
    agentUsing: name => `${name}正在使用屏幕`,
    youControl: '由你操作',
    handingBack: '正在交还…',
    elsewhere: '正在另一个窗口中操作',
    takeOver: '接管',
    handBackContinue: '交还并继续',
    handBackForce: '交还（强制）',
    handBackForceHint: '结束之前未关闭的操作',
    reconnect: '重新连接',
    watchLine: name => `${name}在云端的浏览器。接管后可登录或输入验证码。`,
    controlLine: name => `你操作时，${name}会等待。`,
    connecting: '正在连接屏幕…',
    idle: name => `${name}开始使用浏览器后，屏幕会显示在这里。`,
    streamLost: '屏幕已停止更新。',
    controlMoved: '操作已转到另一个窗口。',
    unavailable: '屏幕暂时无法使用。',
    ownerOnly: '只有所有者才能查看此屏幕。',
    continueMessage: '好了，请继续。'
  },
  'zh-hant': {
    tab: '螢幕',
    agentUsing: name => `${name}正在使用螢幕`,
    youControl: '由你操作',
    handingBack: '正在交還…',
    elsewhere: '正在另一個視窗中操作',
    takeOver: '接管',
    handBackContinue: '交還並繼續',
    handBackForce: '交還（強制）',
    handBackForceHint: '結束之前未關閉的操作',
    reconnect: '重新連線',
    watchLine: name => `${name}在雲端的瀏覽器。接管後可登入或輸入驗證碼。`,
    controlLine: name => `你操作時，${name}會等待。`,
    connecting: '正在連線螢幕…',
    idle: name => `${name}開始使用瀏覽器後，螢幕會顯示在這裡。`,
    streamLost: '螢幕已停止更新。',
    controlMoved: '操作已轉到另一個視窗。',
    unavailable: '螢幕暫時無法使用。',
    ownerOnly: '只有擁有者才能查看此螢幕。',
    continueMessage: '好了，請繼續。'
  }
}

export function matrixAgentScreenText(locale: DesktopLocale): MatrixAgentScreenCopy {
  return copy[locale]
}
