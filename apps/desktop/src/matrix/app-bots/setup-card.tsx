import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { DmIntakeDialog } from '@/app/dm/dm-intake-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useI18n } from '@/i18n'
import {
  type AppSurfaceResult,
  type AtumAppSurfaceClient,
  type IntakeStatus,
  isAppSurfaceFailure
} from '@/lib/atum-app-surfaces'

import {
  appBotGuestReady,
  appBotGuestState,
  type AppBotStatus,
  parseAppBotStatus
} from '../../../shared/app-bot-status'
import {
  appBotDisclosureVersion,
  type AppDescriptor,
  usesContainedAppOnboarding
} from '../../../shared/app-catalog'
import { requiresPlatformConnection } from '../../../shared/app-view/protocol'
import type { MatrixSnapshot } from '../../../shared/matrix'
import { appOnboardingCopy, appOnboardingTerms } from '../../../shared/matrix-app-onboarding-copy'
import { matrixDisplayMode } from '../../../shared/matrix-display-preferences'

import { AppStartDialog } from './start-dialog'

function parseBotStatus(value: unknown): AppBotStatus {
  const parsed = parseAppBotStatus(value)

  if (!parsed) {
    throw new Error('app_bot_status_invalid')
  }

  return parsed
}

/**
 * What the linked-only disclosure says about an app's memory. Only Moon's and Andy's are written
 * (they are what those two apps do); any other app says nothing here rather than something that is
 * not true of it. A new app's own terms are the platform's to supply with its disclosure version.
 */
const memoryPoint = {
  en: (app: string, groups: boolean) => groups ? `In this private chat ${app} remembers your conversation so it can answer you better. In groups ${app} uses no one's memory or profile.` : `In this private chat ${app} remembers your conversation so it can answer you better.`,
  vi: (app: string, groups: boolean) => groups ? `Trong chat riêng này, ${app} nhớ cuộc trò chuyện của bạn để trả lời tốt hơn. Trong nhóm, ${app} không dùng ký ức hay hồ sơ của ai.` : `Trong chat riêng này, ${app} nhớ cuộc trò chuyện của bạn để trả lời tốt hơn.`,
  ja: (app: string, groups: boolean) => groups ? `このプライベートチャットでは、${app} は会話を覚えて、より良い回答に役立てます。グループでは、${app} は誰の記憶やプロフィールも使いません。` : `このプライベートチャットでは、${app} は会話を覚えて、より良い回答に役立てます。`,
  zh: (app: string, groups: boolean) => groups ? `${app} 会记住这段私聊，以便更好地回答您。在群组中，${app} 不使用任何人的记忆或个人资料。` : `${app} 会记住这段私聊，以便更好地回答您。`,
  'zh-hant': (app: string, groups: boolean) => groups ? `${app} 會記住這段私人聊天，以便更好地回覆您。在群組中，${app} 不使用任何人的記憶或個人資料。` : `${app} 會記住這段私人聊天，以便更好地回覆您。`
}

const copy = {
  en: {
    title: (app: string) => `Chat with ${app}`,
    points: (app: string, handle: string, groups: boolean, history: boolean) => [
      `${app} runs on Atum's servers and answers every message you send in this private chat.`,
      groups
        ? `In a group, ${app} answers only when you mention @${handle} or reply to ${app}. Atum's server receives the group's messages like any member does, but passes to ${app} only the message you send it and one message you choose to quote. Readable copies of the rest are discarded at once; like any member, the server keeps the encrypted copies and the keys to them, sealed, while ${app} is in the group.`
        : `${app} chats one-on-one only.`,
      memoryPoint.en(app, groups),
      ...(history
        ? [
            `Atum loads earlier private messages from your linked ${app} account when you open this chat. They aren’t added to your Atum chat history.`
          ]
        : []),
      `Each question uses messages from your own ${app} account, paid in ${app}, not with Protons. No one pays for you, and you never pay for anyone else.`,
      `${app}'s answers go to every device signed in to your account, including ones you haven't verified.`,
      'You can stop anytime in Atum Settings.'
    ],
    waiting: (app: string) => `Sign in to ${app} in your browser, then come back here.`,
    elsewhere: 'Finish connecting where you started, or cancel and connect here.',
    finishing: 'Connecting…', cancel: 'Cancel',
    timedOut: 'That took too long. Try again.',
    readying: (app: string) => `${app} is getting ready. This takes a moment.`, checkAgain: 'Check again',
    slow: (app: string) => `${app} is still getting ready. Check again in a little while.`,
    notReady: (app: string) => `${app} isn't ready yet. Connect again, or check later.`,
    startLine: (app: string) => `Chat with ${app} right here in Atum.`, startChat: 'Start chat', learnMore: 'Learn more',
    connect: 'Connect app', continue: 'Continue', checking: 'Finishing setup…', retry: 'Try again', failed: 'Setup could not be completed.',
    update: (app: string) => `Update Atum to set up ${app}. This version can't show ${app}'s current terms.`
  },
  vi: {
    title: (app: string) => `Trò chuyện với ${app}`,
    points: (app: string, handle: string, groups: boolean, history: boolean) => [
      `${app} chạy trên máy chủ của Atum và trả lời mọi tin nhắn bạn gửi trong chat riêng này.`,
      groups
        ? `Trong nhóm, ${app} chỉ trả lời khi bạn nhắc @${handle} hoặc trả lời tin của ${app}. Máy chủ Atum nhận tin nhắn của nhóm như mọi thành viên, nhưng chỉ chuyển cho ${app} tin bạn gửi cho ${app} và một tin bạn chọn trích dẫn. Bản đọc được của các tin khác bị bỏ đi ngay; như mọi thành viên, máy chủ vẫn giữ bản mã hóa và khóa giải mã, được niêm phong, khi ${app} còn trong nhóm.`
        : `${app} chỉ trò chuyện riêng.`,
      memoryPoint.vi(app, groups),
      ...(history
        ? [
            `Atum tải các tin nhắn riêng trước đây từ tài khoản ${app} đã liên kết khi bạn mở cuộc trò chuyện này. Những tin nhắn này sẽ không được lưu vào lịch sử trò chuyện Atum của bạn.`
          ]
        : []),
      `Mỗi câu hỏi dùng lượt nhắn trong tài khoản ${app} của chính bạn và thanh toán trong ${app}, không dùng Proton. Không ai trả thay bạn, và bạn không trả thay ai.`,
      `Câu trả lời của ${app} được gửi tới mọi thiết bị đăng nhập vào tài khoản của bạn, kể cả thiết bị bạn chưa xác minh.`,
      'Bạn có thể dừng bất cứ lúc nào trong Cài đặt Atum.'
    ],
    waiting: (app: string) => `Đăng nhập ${app} trên trình duyệt, rồi quay lại đây.`,
    elsewhere: 'Hoàn tất kết nối ở nơi bạn đã bắt đầu, hoặc hủy rồi kết nối tại đây.',
    finishing: 'Đang kết nối…', cancel: 'Hủy',
    timedOut: 'Đã chờ quá lâu. Bạn thử lại nhé.',
    readying: (app: string) => `${app} đang chuẩn bị. Bạn chờ một chút nhé.`, checkAgain: 'Kiểm tra lại',
    slow: (app: string) => `${app} vẫn đang chuẩn bị. Bạn kiểm tra lại sau ít phút nhé.`,
    notReady: (app: string) => `${app} chưa sẵn sàng. Bạn kết nối lại, hoặc kiểm tra sau nhé.`,
    startLine: (app: string) => `Trò chuyện với ${app} ngay trong Atum.`, startChat: 'Bắt đầu', learnMore: 'Tìm hiểu thêm',
    connect: 'Kết nối ứng dụng', continue: 'Tiếp tục', checking: 'Đang hoàn tất thiết lập…', retry: 'Thử lại', failed: 'Không thể hoàn tất thiết lập.',
    update: (app: string) => `Bạn cần cập nhật Atum để bắt đầu với ${app}. Phiên bản này chưa hiển thị được điều khoản mới nhất của ${app}.`
  },
  ja: {
    title: (app: string) => `${app} とチャット`,
    points: (app: string, handle: string, groups: boolean, history: boolean) => [
      `${app} はAtumのサーバーで動作し、このプライベートチャットであなたが送るすべてのメッセージに返答します。`,
      groups ? `グループでは、${app} は@${handle}へのメンションまたは${app}への返信にだけ応答します。Atumのサーバーは他の参加者と同様にグループのメッセージを受け取りますが、${app} に渡すのはあなたが送ったメッセージと、あなたが選んだ引用1件だけです。その他の読み取り可能なコピーはすぐに破棄され、暗号化されたコピーと鍵は${app}がグループにいる間、他の参加者と同じように封印された状態で保持されます。` : `${app} は1対1のチャットのみ対応しています。`,
      memoryPoint.ja(app, groups),
      ...(history
        ? [
            `このチャットを開くと、Atumは連携した${app}アカウントから以前のプライベートメッセージを読み込みます。Atumのチャット履歴には追加されません。`
          ]
        : []),
      `各質問はあなた自身の${app}アカウントのメッセージを使い、Protonではなく${app}で支払われます。誰もあなたの代わりに支払わず、あなたも他の人の代わりに支払いません。`,
      `${app}の回答は、未確認の端末を含め、あなたのアカウントにサインインしているすべての端末に届きます。`,
      'Atum設定からいつでも停止できます。'
    ],
    waiting: (app: string) => `ブラウザで${app}にサインインしてから、ここに戻ってください。`,
    elsewhere: '開始した画面で接続を完了するか、キャンセルしてここで接続してください。',
    finishing: '接続しています…', cancel: 'キャンセル',
    timedOut: '時間がかかりすぎました。もう一度お試しください。',
    readying: (app: string) => `${app}の準備をしています。少しお待ちください。`, checkAgain: '再確認',
    slow: (app: string) => `${app}はまだ準備中です。しばらくしてから再確認してください。`,
    notReady: (app: string) => `${app}はまだ準備ができていません。もう一度接続するか、後で確認してください。`,
    startLine: (app: string) => `Atumの中で、${app}とそのままチャットできます。`, startChat: 'チャットを開始', learnMore: '詳しく見る',
    connect: 'アプリを接続', continue: '続ける', checking: '設定を完了しています…', retry: '再試行', failed: '設定を完了できませんでした。',
    update: (app: string) => `${app} を始めるには Atum を更新してください。このバージョンでは ${app} の最新の利用条件を表示できません。`
  },
  zh: {
    title: (app: string) => `与 ${app} 聊天`,
    points: (app: string, handle: string, groups: boolean, history: boolean) => [
      `${app} 在 Atum 的服务器上运行，并会回复您在这段私聊中发送的每条消息。`,
      groups ? `在群组中，${app} 只会在您提及 @${handle} 或回复 ${app} 时回答。Atum 的服务器和任何成员一样接收群消息，但只会把您发送给 ${app} 的消息及您选择引用的一条消息传给 ${app}。其余消息的可读副本会立即丢弃；与其他成员一样，服务器会在 ${app} 留在群组期间保留加密副本和密钥，并将其封存。` : `${app} 目前仅支持一对一聊天。`,
      memoryPoint.zh(app, groups),
      ...(history
        ? [`打开此聊天时，Atum 会从已关联的 ${app} 账户加载过去的私聊消息。这些消息不会添加到您的 Atum 聊天记录。`]
        : []),
      `每个问题都会使用您自己的 ${app} 账户中的消息额度，并在 ${app} 中付费，不使用 Proton。没有人替您付费，您也不会替任何人付费。`,
      `${app} 的回答会发送到所有登录您账户的设备，包括您尚未验证的设备。`,
      '您可以随时在 Atum 设置中停止使用。'
    ],
    waiting: (app: string) => `请在浏览器中登录 ${app}，然后回到这里。`,
    elsewhere: '请在开始连接的地方完成连接，或取消后在这里连接。',
    finishing: '正在连接…', cancel: '取消',
    timedOut: '等待时间过长，请重试。',
    readying: (app: string) => `${app} 正在准备，请稍候。`, checkAgain: '再次检查',
    slow: (app: string) => `${app} 仍在准备中，请稍后再检查。`,
    notReady: (app: string) => `${app} 还没准备好。请重新连接，或稍后再检查。`,
    startLine: (app: string) => `直接在 Atum 里与 ${app} 聊天。`, startChat: '开始聊天', learnMore: '了解更多',
    connect: '连接应用', continue: '继续', checking: '正在完成设置…', retry: '重试', failed: '无法完成设置。',
    update: (app: string) => `请更新 Atum 以开始使用 ${app}。此版本无法显示 ${app} 的最新条款。`
  },
  'zh-hant': {
    title: (app: string) => `與 ${app} 聊天`,
    points: (app: string, handle: string, groups: boolean, history: boolean) => [
      `${app} 在 Atum 的伺服器上執行，並會回覆您在這段私人聊天中傳送的每則訊息。`,
      groups ? `在群組中，${app} 只會在您提及 @${handle} 或回覆 ${app} 時回答。Atum 的伺服器和任何成員一樣接收群組訊息，但只會把您傳送給 ${app} 的訊息及您選擇引用的一則訊息傳給 ${app}。其餘訊息的可讀副本會立即丟棄；與其他成員一樣，伺服器會在 ${app} 留在群組期間保留加密副本和金鑰，並將其封存。` : `${app} 目前只支援一對一聊天。`,
      memoryPoint['zh-hant'](app, groups),
      ...(history
        ? [`開啟此聊天時，Atum 會從已連結的 ${app} 帳戶載入過去的私人訊息。這些訊息不會加入您的 Atum 聊天記錄。`]
        : []),
      `每個問題都會使用您自己的 ${app} 帳戶中的訊息額度，並在 ${app} 中付費，不使用 Proton。沒有人替您付費，您也不會替任何人付費。`,
      `${app} 的回答會傳送到所有登入您帳戶的裝置，包括您尚未驗證的裝置。`,
      '您可以隨時在 Atum 設定中停止使用。'
    ],
    waiting: (app: string) => `請在瀏覽器中登入 ${app}，然後回到這裡。`,
    elsewhere: '請在開始連結的地方完成連結，或取消後在這裡連結。',
    finishing: '正在連結…', cancel: '取消',
    timedOut: '等待時間過長，請再試一次。',
    readying: (app: string) => `${app} 正在準備，請稍候。`, checkAgain: '再次檢查',
    slow: (app: string) => `${app} 仍在準備中，請稍後再檢查。`,
    notReady: (app: string) => `${app} 還沒準備好。請重新連結，或稍後再檢查。`,
    startLine: (app: string) => `直接在 Atum 裡與 ${app} 聊天。`, startChat: '開始聊天', learnMore: '瞭解更多',
    connect: '連結應用程式', continue: '繼續', checking: '正在完成設定…', retry: '重試', failed: '無法完成設定。',
    update: (app: string) => `請更新 Atum 以開始使用 ${app}。此版本無法顯示 ${app} 的最新條款。`
  }
} as const

/** Guest-first copy for apps that can chat without a provider login. The linked-only
 * disclosure above stays byte-identical for Moon and Andy. */
const guestCopy = {
  en: {
    points: (app: string) => [
      `${app} runs on its own service, not on Atum. Atum sends ${app} only what you write in this private chat.`,
      `You can chat as a guest without a ${app} login. Atum creates a private guest identity for this app and this Atum account.`,
      `Guest messages share a limited allowance. When it runs out, connect a ${app} account to keep chatting.`,
      `Connecting an account is optional. New messages then use that account's own context; earlier guest messages stay in this chat and are not imported.`,
      `You can stop anytime in Atum Settings.`
    ],
    connect: 'Connect account',
    starting: 'Starting guest chat…',
    unavailable: (app: string) => `${app}'s guest chat is unavailable right now. Try again in a few minutes.`,
    boundary: (app: string) => `Connected. New messages use your linked ${app} account. Earlier guest messages stay in this chat and are not imported.`
  },
  vi: {
    points: (app: string) => [
      `${app} chạy trên dịch vụ riêng, không phải máy chủ Atum. Atum chỉ gửi cho ${app} những gì bạn viết trong chat riêng này.`,
      `Bạn có thể trò chuyện với tư cách khách mà không cần đăng nhập ${app}. Atum tạo một danh tính khách riêng cho ứng dụng này và tài khoản Atum này.`,
      `Tin nhắn khách dùng chung một số lượt có hạn. Khi hết lượt, hãy kết nối tài khoản ${app} để tiếp tục trò chuyện.`,
      `Kết nối tài khoản là tùy chọn. Tin nhắn mới sau đó dùng ngữ cảnh của tài khoản đó; các tin nhắn khách trước đây vẫn ở trong chat này và không được nhập vào.`,
      `Bạn có thể dừng bất cứ lúc nào trong Cài đặt Atum.`
    ],
    connect: 'Kết nối tài khoản',
    starting: 'Đang bắt đầu chat khách…',
    unavailable: (app: string) => `Chat khách với ${app} hiện chưa dùng được. Bạn thử lại sau ít phút nhé.`,
    boundary: (app: string) => `Đã kết nối. Tin nhắn mới dùng tài khoản ${app} đã liên kết của bạn. Các tin nhắn khách trước đây vẫn ở trong chat này và không được nhập vào.`
  },
  ja: {
    points: (app: string) => [
      `${app} はAtumではなく${app}のサービス上で動作します。Atumはこのプライベートチャットであなたが書いた内容だけを${app}に送ります。`,
      `${app}にログインしなくてもゲストとしてチャットできます。AtumがこのアプリとこのAtumアカウント用のプライベートなゲストIDを作成します。`,
      `ゲストメッセージには上限があります。上限に達したら、${app}アカウントを接続すると続けられます。`,
      `アカウントの接続は任意です。接続後の新しいメッセージはそのアカウントのコンテキストを使います。以前のゲストメッセージはこのチャットに残り、取り込まれません。`,
      `Atum設定からいつでも停止できます。`
    ],
    connect: 'アカウントを接続',
    starting: 'ゲストチャットを開始しています…',
    unavailable: (app: string) => `${app}のゲストチャットは現在利用できません。数分後にもう一度お試しください。`,
    boundary: (app: string) => `接続しました。新しいメッセージはリンクした${app}アカウントを使います。以前のゲストメッセージはこのチャットに残り、取り込まれません。`
  },
  zh: {
    points: (app: string) => [
      `${app} 在其自己的服务上运行，而不是在 Atum 上。Atum 只把您在这段私聊中写的内容发送给 ${app}。`,
      `您无需登录 ${app} 即可作为访客聊天。Atum 会为此应用和此 Atum 账户创建一个私密访客身份。`,
      `访客消息共享有限额度。额度用完后，连接 ${app} 账户即可继续聊天。`,
      `连接账户是可选的。之后的新消息会使用该账户自己的上下文；之前的访客消息会留在此聊天中，不会被导入。`,
      `您可以随时在 Atum 设置中停止。`
    ],
    connect: '连接账户',
    starting: '正在开始访客聊天…',
    unavailable: (app: string) => `${app} 的访客聊天目前不可用。请几分钟后再试。`,
    boundary: (app: string) => `已连接。新消息将使用您关联的 ${app} 账户。之前的访客消息会留在此聊天中，不会被导入。`
  },
  'zh-hant': {
    points: (app: string) => [
      `${app} 在其自己的服務上執行，而不是在 Atum 上。Atum 只會把您在這段私人聊天中寫的內容傳送給 ${app}。`,
      `您無需登入 ${app} 即可作為訪客聊天。Atum 會為此應用程式和此 Atum 帳戶建立一個私密訪客身分。`,
      `訪客訊息共用有限額度。額度用完後，連結 ${app} 帳戶即可繼續聊天。`,
      `連結帳戶是選用的。之後的新訊息會使用該帳戶自己的上下文；之前的訪客訊息會留在這個聊天中，不會被匯入。`,
      `您可以隨時在 Atum 設定中停止。`
    ],
    connect: '連結帳戶',
    starting: '正在開始訪客聊天…',
    unavailable: (app: string) => `${app} 的訪客聊天目前無法使用。請幾分鐘後再試。`,
    boundary: (app: string) => `已連結。新訊息將使用您連結的 ${app} 帳戶。之前的訪客訊息會留在這個聊天中，不會被匯入。`
  }
} as const

/** Consent is recorded only for
 * the text the person saw: a newer disclosure needs a newer Atum, and the platform refuses a
 * consent to a version it has moved on from (`disclosure_version_stale`). Main checks the same
 * version on a fresh read before it confirms a link by itself. */
// How long the card keeps looking at a link the platform says is still getting ready (the
// claim.redeemed delivery to the app). The platform delivers right after confirm; this is the
// backstop for a slow delivery. After it, a quiet Check again, never Connect while pending.
const READY_WAIT_MS = 6 * 60_000
// Gaps between those looks: quick at first, then every 20 s.
const READY_BACKOFF_MS = [2_000, 3_000, 5_000, 8_000, 13_000, 20_000] as const
// The first read of the bot's status when the card opens. The platform answers a request now and
// then with a timeout or a 503; the card looks again by itself before it asks anyone to tap Try again.
const STATUS_RETRY_MS = [2_000, 5_000, 10_000] as const

/** The nodes a step really has: each condition above yields its element or a falsy value. */
function present(nodes: ReadonlyArray<ReactElement | false | null | undefined | ''>): ReactElement[] {
  return nodes.filter((node): node is ReactElement => Boolean(node))
}

/**
 * Setup lives in the official DM so consent and account linking cannot be
 * mistaken for a room invitation.  Main owns both requests; this component
 * receives only the current catalog projection and result states.
 */
export function AppBotSetupCard({
  app,
  snapshot,
  onReadyChange
}: {
  app: AppDescriptor
  snapshot: MatrixSnapshot
  onReadyChange?: (ready: boolean) => void
}) {
  const { locale } = useI18n()
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const appearance = matrixDisplayMode(snapshot.displayPreferences?.appearance.value, systemDark)
  const text = copy[locale]
  const bridge = window.atumMatrix.apps
  const [status, setStatus] = useState<AppBotStatus | null>(null)
  const [intake, setIntake] = useState<'idle' | 'checking' | 'required' | 'complete'>('idle')
  const [intakeOpen, setIntakeOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const bot = app.bot
  const shownDisclosureVersion = appBotDisclosureVersion(app)
  const containedOnboarding = usesContainedAppOnboarding(app)
  const containedCopy = appOnboardingCopy(locale)
  const containedAppCopy = containedOnboarding ? appOnboardingTerms(locale, app.app) : null
  const botAvailable = Boolean(bot)
  const guestEnabled = bot?.guest_enabled === true
  const guestText = guestCopy[locale]
  const [guestBoundary, setGuestBoundary] = useState(false)
  const previousGuest = useRef<string | null>(null)
  const refreshedAfterIntake = useRef(false)
  const setupGeneration = useRef(0)

  const intakeClient = useMemo<Pick<AtumAppSurfaceClient, 'intakeStatus' | 'submitIntake'>>(
    () => ({
      intakeStatus: async (): Promise<AppSurfaceResult<IntakeStatus>> => {
        if (!bridge) {
          return { error: 'app_surface_unavailable' }
        }

        const result = await bridge.botIntakeStatus(app.app_id) as AppSurfaceResult<IntakeStatus>

        // Older specialists have no intake route. Capability absence means
        // there is nothing to collect, not that an otherwise ready DM broke.
        return isAppSurfaceFailure(result) && result.error === 'app_surface_absent'
          ? { complete: true, fields: [] }
          : result
      },
      submitIntake: async (_appId, values): Promise<AppSurfaceResult<IntakeStatus>> => {
        if (!bridge) {
          return { error: 'app_surface_unavailable' }
        }

        return await bridge.botIntakeSubmit(app.app_id, values) as AppSurfaceResult<IntakeStatus>
      }
    }),
    [app.app_id, bridge]
  )

  const room = snapshot.rooms.find(value => value.id === snapshot.roomId)

  const catalogReady = Boolean(
    bot?.consent === 'accepted' &&
    bot.disclosure_version === shownDisclosureVersion &&
    !requiresPlatformConnection(app.link) &&
    room?.participants?.some(member => member.userId === bot.user_id && member.membership === 'join')
  )

  const catalogReadyRef = useRef(catalogReady)
  catalogReadyRef.current = catalogReady

  const finishIntake = useCallback(() => {
    setIntakeOpen(false)
    setFailed(false)

    // A catalog refresh can make the room ready while the intake completion
    // callback is still in flight.  Read the current value without rebuilding
    // this callback (which would otherwise restart the intake effect), and
    // always settle the local gate when this completion was already refreshed.
    if (catalogReadyRef.current || refreshedAfterIntake.current) {
      setIntake('complete')
      onReadyChange?.(true)

      return
    }

    if (!bridge) {
      setIntake('idle')
      setFailed(true)
      onReadyChange?.(false)

      return
    }

    setIntake('checking')
    onReadyChange?.(false)
    refreshedAfterIntake.current = true
    const generation = setupGeneration.current
    void bridge.refresh().then(() => {
      if (generation !== setupGeneration.current) {
        return
      }

      setIntake('complete')
      onReadyChange?.(true)
    }, () => {
      if (generation !== setupGeneration.current) {
        return
      }

      refreshedAfterIntake.current = false
      setIntake('idle')
      setFailed(true)
    })
  }, [bridge, onReadyChange])

  const readIntake = useCallback(async () => {
    const generation = setupGeneration.current
    setIntake('checking')
    setFailed(false)
    onReadyChange?.(false)

    try {
      const result = await intakeClient.intakeStatus(app.app_id)

      if (generation !== setupGeneration.current) {
        return
      }

      if (isAppSurfaceFailure(result)) {
        setIntake('idle')
        setFailed(true)

        return
      }

      if (result.complete) {
        finishIntake()

        return
      }

      setIntake('required')
      setIntakeOpen(true)
    } catch {
      if (generation !== setupGeneration.current) {
        return
      }

      setIntake('idle')
      setFailed(true)
    }
  }, [app.app_id, finishIntake, intakeClient, onReadyChange])

  useEffect(() => {
    let live = true
    const generation = setupGeneration.current + 1
    setupGeneration.current = generation
    refreshedAfterIntake.current = false
    setStatus(null)
    setIntake('idle')
    setIntakeOpen(false)
    setFailed(false)
    onReadyChange?.(false)

    if (!bridge || !bot || snapshot.state !== 'ready') {
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined

    const read = (attempt: number) => {
      void bridge.botStatus(app.app_id).then(value => {
        if (live) {
          try {
            setStatus(parseBotStatus(value))
          } catch {
            setFailed(true)
          }
        }
      }, () => {
        if (!live) {
          return
        }

        const delay = STATUS_RETRY_MS[attempt]

        if (delay === undefined) {
          setFailed(true)
        } else {
          timer = setTimeout(() => read(attempt + 1), delay)
        }
      })
    }

    read(0)

    return () => {
      live = false
      clearTimeout(timer)

      if (setupGeneration.current === generation) {
        setupGeneration.current += 1
      }
    }
  }, [app.app_id, botAvailable, bridge, onReadyChange, snapshot.state])

  const consentAccepted =
    status?.consent.state === 'accepted' && status.consent.disclosure_version === shownDisclosureVersion

  const linked = app.link.mode === 'none' || (status?.link.state === 'linked' && status.link.ready && status.link.available)
  const guestState = appBotGuestState(bot, status)
  const guestReady = guestEnabled && appBotGuestReady(status, shownDisclosureVersion)
  const guestMode = guestEnabled && !linked
  // TODO(account-hint): show which app account got linked, masked, with a one-tap disconnect,
  // so a wrong account is easy to spot (security consult 2026-10-10, auto-confirm condition).
  // No source the card reads carries one: bot status (atum.app-bot-status/1) has only consent
  // and link state, and the connection read (atum-platform app-link-state.ts,
  // projectAppConnectionState) deliberately leaves out identity material. It needs a
  // platform + app change (a masked account label the app supplies at claim, projected on the
  // connection read) first. Do not derive one from anything else. Until then this consult
  // condition is open, and shipping auto-confirm without it is the owner's call.
  // The native link flow main runs (app-connection.ts): browser, then a gated return that
  // confirms by itself for a flow this card started.
  const link = snapshot.apps?.connections?.[app.app]
  const linkPhase = link?.phase
  // Main's own read says linked (a confirm just landed) even before the bot status catches up.
  const snapshotLinked = link?.connection?.state === 'linked'
  const linkedNow = linkPhase === 'idle' && snapshotLinked
  // What the platform says about that link getting ready; unknown until main reads the link.
  const readiness = snapshotLinked ? link?.connection?.readiness : undefined
  // Linked, but the app is still being set up for this account (provider delivery).
  const readying = consentAccepted && !linked && (status?.link.state === 'linked' || snapshotLinked)
  // A link that will not settle by itself: the app is not available, or its delivery is missing
  // or dead-lettered. A fresh link is how it recovers, so Connect is offered again at once.
  const recover = readying && (status?.link.available === false || readiness === 'unavailable')
  const [readyLooks, setReadyLooks] = useState(0)
  const [readyWaited, setReadyWaited] = useState(0)
  const readyGaveUp = readyWaited >= READY_WAIT_MS
  // Still getting ready: keep looking, with backoff, for up to READY_WAIT_MS.
  const waitingOnReady = readying && !recover && !readyGaveUp
  // Looked long enough: a quiet Check again.
  const slowReady = readying && !recover && readyGaveUp
  // While the platform says pending, Connect is never offered again: a second link would not
  // make the first delivery arrive sooner. After the wait it is offered only if the platform
  // no longer says pending (for instance a read that could not tell).
  const holdConnect = readying && !recover && (!readyGaveUp || readiness === 'pending')
  // The linked Connect flow's own controls and lines (waiting, connecting, failed, Connect).
  // A guest turn never runs this flow: connecting an account is an optional, separate action.
  const flow = !guestEnabled && consentAccepted && !linked && !holdConnect
  const previousPhase = useRef(linkPhase)

  useEffect(() => {
    if (!guestEnabled) {
      return
    }

    if (guestReady) {
      onReadyChange?.(true)
    } else if (!linked) {
      onReadyChange?.(false)
    }
  }, [guestEnabled, guestReady, linked, onReadyChange])

  // The platform starts a clean provider context for the linked account. Label that
  // boundary once in this card's lifetime; the old guest transcript stays in the room.
  useEffect(() => {
    if (!guestEnabled || !status) {
      return
    }

    const current = appBotGuestState(bot, status)
    const previous = previousGuest.current
    previousGuest.current = current

    if (current === 'linked' && (previous === 'ready' || previous === 'start_required')) {
      setGuestBoundary(true)
    }
  }, [app.app_id, bot, guestEnabled, status])

  // Finishing (or another window finishing) makes the link: read the bot's status again so
  // the card moves on to the chat instead of offering Connect a second time. A connect that
  // ends in failure is read again too: main refuses one whose consent no longer stands, and
  // the card then shows the disclosure again instead of a Connect that would fail the same way.
  useEffect(() => {
    const before = previousPhase.current
    previousPhase.current = linkPhase
    const confirmFailed = before === 'confirming' && linkPhase === 'failed'

    if (!bridge || !bot || (!linkedNow && !confirmFailed) || before === linkPhase) {
      return
    }

    if (linkedNow) {
      setReadyLooks(0)
      setReadyWaited(0)
    }

    let live = true
    void bridge.botStatus(app.app_id).then(value => {
      if (live) {
        try {
          setStatus(parseBotStatus(value))
        } catch {
          setFailed(true)
        }
      }
    }, () => {
      if (live) {
        setFailed(true)
      }
    })

    return () => {
      live = false
    }
  }, [app.app_id, botAvailable, bridge, linkPhase, linkedNow])

  // A link the app is still readying settles by itself: keep looking, further apart each time.
  // Each look has main read the link (its readiness lands in the snapshot), then the bot.
  useEffect(() => {
    if (!bridge || !bot || !waitingOnReady) {
      return
    }

    let live = true
    const delay = READY_BACKOFF_MS[Math.min(readyLooks, READY_BACKOFF_MS.length - 1)]

    const timer = setTimeout(() => {
      void (async () => {
        await bridge.connection(app.app_id, 'read').catch(() => {})

        try {
          const value = parseBotStatus(await bridge.botStatus(app.app_id))

          if (live) {
            setStatus(value)
          }
        } catch {
          // The next look, or Check again, recovers.
        }

        if (live) {
          setReadyLooks(count => count + 1)
          setReadyWaited(waited => waited + delay)
        }
      })()
    }, delay)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [app.app_id, botAvailable, bridge, readyLooks, waitingOnReady])

  useEffect(() => {
    if (!bridge || !bot || !consentAccepted || !linked) {
      return
    }

    void readIntake()
  }, [botAvailable, bridge, consentAccepted, linked, readIntake])

  if (!bridge || !bot) {
    return null
  }

  if (consentAccepted && linked && intake === 'complete') {
    return guestBoundary ? (
      <NoticeBand className="mx-auto mb-3 w-[min(42rem,calc(100%-2rem))]" data-app-bot-context="linked" role="status" tone="notice">
        <p className="text-sm">{guestText.boundary(bot.display_name)}</p>
      </NoticeBand>
    ) : null
  }

  const botApp = { ...app, bot }

  // A disclosure this Atum has no words for cannot be agreed to here: the dialog says to update, with nothing to press.
  if (!consentAccepted && bot.disclosure_version !== shownDisclosureVersion) {
    return <AppStartDialog app={botApp} appearance={appearance} line={text.update(bot.display_name)} lineProps={{ 'data-app-bot-update': true }} />
  }

  // Check again: read the link and the bot now, and look for READY_WAIT_MS more.
  const refreshStatus = async () => {
    setPending(true)
    setFailed(false)
    setReadyLooks(0)
    setReadyWaited(0)

    try {
      if (readying) {
        await bridge.connection(app.app_id, 'read').catch(() => {})
      }

      setStatus(parseBotStatus(await bridge.botStatus(app.app_id)))
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  const accept = async () => {
    setPending(true); setFailed(false)

    try {
      const accepted = parseBotStatus(await bridge.botConsent(app.app_id, shownDisclosureVersion, locale))

      if (guestEnabled) {
        // Start/Resume accepts the same disclosure and prepares the installation in
        // one platform call. No provider login and no account link is implied.
        const current = parseBotStatus(await bridge.botStatus(app.app_id))
        setStatus(current)

        if (appBotGuestReady(current, shownDisclosureVersion)) {
          onReadyChange?.(true)
          await bridge.refresh().catch(() => {})
        }
      } else {
        // An existing link that is still getting ready is waited on, not linked a second time.
        if (requiresPlatformConnection({ ...app.link, state: accepted.link.state })) {
          await bridge.connection(app.app_id, 'begin', { autoConfirm: true })
        }

        setStatus(parseBotStatus(await bridge.botStatus(app.app_id)))
      }
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  // Optional account connection. It still records the same disclosure first: the platform
  // admits no account link without current app-bot consent.
  const connectAccount = async () => {
    if (app.link.mode !== 'external_account') {return}
    setPending(true); setFailed(false)

    try {
      const current = consentAccepted
        ? status
        : parseBotStatus(await bridge.botConsent(app.app_id, shownDisclosureVersion, locale))

      setStatus(current)
      await bridge.connection(app.app_id, 'begin', { autoConfirm: true })
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  // Connect starts the browser sign-in; its progress comes back in the snapshot (`link`). The
  // person agreed to the disclosure this card showed before Connect is offered, so the flow
  // confirms by itself when the browser comes back through main's gate: no second tap.
  const connect = async () => {
    if (app.link.mode !== 'external_account') {return}
    setPending(true); setFailed(false)

    try {
      await bridge.connection(app.app_id, 'begin', { autoConfirm: true })
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  const cancelLink = () => {
    void bridge.connection(app.app_id, 'cancel').catch(() => {})
  }

  const retry = () => {
    // A link that is still getting ready is looked at again, never linked a second time.
    if (!status || (readying && !recover) || (guestEnabled && guestState === 'unavailable')) {
      void refreshStatus()
    } else if (guestEnabled) {
      void (guestState === 'start_required' ? accept() : refreshStatus())
    } else if (consentAccepted && linked) {
      void readIntake()
    } else {
      void (consentAccepted ? connect() : accept())
    }
  }

  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // the start step is the app's face, its name, one line and Start chat; the full terms are one tap away).
  // It says what stands between the person and the chat, and nothing else: not while the first read of
  // the bot is out, and not for a chat that is already set up (the catalog says so, and the reads that
  // follow only confirm it), where a dialog flashing up and away on every open is exactly the flash this
  // replaces.
  const needsConsent = Boolean(status) && (guestEnabled ? guestState === 'start_required' : !consentAccepted)
  const textClass = 'mt-1 text-sm text-(--atum-ink-soft)'

  const lines = present([
    guestEnabled && status && guestState === 'unavailable' && (
      <p className={textClass} data-app-bot-guest="unavailable" key="guest-unavailable">{guestText.unavailable(bot.display_name)}</p>
    ),
    guestEnabled && pending && guestMode && !guestReady && (
      <p className={textClass} data-app-bot-guest="starting" key="guest-starting">{guestText.starting}</p>
    ),
    consentAccepted && linked && intake === 'checking' && !catalogReady && (
      <p className={textClass} key="checking">{containedOnboarding ? containedCopy.checking : text.checking}</p>
    ),
    waitingOnReady && (
      <p className={textClass} data-app-bot-link="readying" key="readying">{containedOnboarding ? containedCopy.working(bot.display_name) : text.readying(bot.display_name)}</p>
    ),
    slowReady && holdConnect && (
      <p className={textClass} data-app-bot-link="slow" key="slow">{containedOnboarding ? containedCopy.slow(bot.display_name) : text.slow(bot.display_name)}</p>
    ),
    readying && !holdConnect && (!linkPhase || linkPhase === 'idle') && (
      <p className={textClass} data-app-bot-link="not-ready" key="not-ready">{containedOnboarding ? containedCopy.notReady(bot.display_name) : text.notReady(bot.display_name)}</p>
    ),
    flow && (linkPhase === 'opening' || linkPhase === 'waiting') && (
      <p className={textClass} data-app-bot-link="waiting" key="waiting">{containedOnboarding ? containedCopy.waiting(bot.display_name) : text.waiting(bot.display_name)}</p>
    ),
    // Only a flow started elsewhere (the Apps page) still waits for its own tap there.
    flow && linkPhase === 'confirm' && (
      <p className={textClass} data-app-bot-link="confirm" key="confirm">{text.elsewhere}</p>
    ),
    flow && linkPhase === 'confirming' && (
      <p className={textClass} data-app-bot-link="confirming" key="confirming">{containedOnboarding ? containedCopy.working(bot.display_name) : text.finishing}</p>
    ),
    flow && linkPhase === 'failed' && !failed && (
      <p className={textClass} data-app-bot-link="failed" key="link-failed">
        {link?.error === 'timed_out'
          ? (containedOnboarding ? containedCopy.timedOut : text.timedOut)
          : (containedOnboarding ? containedCopy.failed : text.failed)}
      </p>
    ),
    failed && <p className={textClass} key="failed">{containedOnboarding ? containedCopy.failed : text.failed}</p>
  ])

  const actions = present([
    // Both ways of agreeing are this one button: it records consent to the disclosure the sheet below
    // shows (`accept`), and goes on to start a guest chat, or a self-confirming account link.
    needsConsent && (
      <Button disabled={pending} key="start" onClick={() => void accept()} size="lg" type="button">{text.startChat}</Button>
    ),
    flow && (!linkPhase || linkPhase === 'idle' || linkPhase === 'failed') && (
      <Button disabled={pending} key="connect" onClick={() => void connect()} size="lg" type="button">{containedOnboarding ? text.startChat : text.connect}</Button>
    ),
    // No Hủy during Đang kết nối…: the confirm is already on its way and cannot be called
    // back, so a cancel would only hide a link the platform makes anyway.
    flow && (linkPhase === 'opening' || linkPhase === 'waiting' || linkPhase === 'confirm') && (
      <Button key="cancel" onClick={cancelLink} size="sm" type="button" variant="text">{containedOnboarding ? containedCopy.cancel : text.cancel}</Button>
    ),
    readying && (
      <Button disabled={pending} key="check-again" onClick={() => void refreshStatus()} size="sm" type="button" variant="text">{containedOnboarding ? containedCopy.checkAgain : text.checkAgain}</Button>
    ),
    guestEnabled && status && guestState === 'unavailable' && (
      <Button disabled={pending} key="guest-check-again" onClick={() => void refreshStatus()} size="sm" type="button" variant="text">{text.checkAgain}</Button>
    ),
    consentAccepted && linked && intake === 'required' && (
      <Button key="continue" onClick={() => setIntakeOpen(true)} size="lg" type="button">{text.continue}</Button>
    ),
    failed && (
      <Button disabled={pending} key="retry" onClick={retry} size="sm" type="button" variant="text">{containedOnboarding ? containedCopy.retry : text.retry}</Button>
    )
  ])

  const showDialog = needsConsent || lines.length > 0 || actions.length > 0

  // Connecting the person's own account is optional for a guest chat and never in the way: a quiet line
  // above the composer once the chat has started, not a step in the dialog.
  const optionalConnect =
    app.link.mode === 'external_account' && !showDialog && guestEnabled && Boolean(status) && guestState !== 'linked' && guestState !== 'unsupported' && guestState !== 'unavailable'

  // The full terms, only on a tap: Moon's and Andy's contained reader, or the shared disclosure.
  const terms = containedAppCopy
    ? containedAppCopy.terms
    : guestEnabled
      ? guestText.points(bot.display_name)
      : text.points(bot.display_name, bot.handle, bot.groups, app.has_history === true)

  return (
    <>
      {showDialog && (
        <AppStartDialog
          app={botApp}
          appearance={appearance}
          line={needsConsent ? text.startLine(bot.display_name) : undefined}
          lineProps={{ 'data-app-bot-start-line': true }}
        >
          {lines}
          {actions.length > 0 && <div className="mt-3 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
          {needsConsent && (
            <Button className="mt-1" onClick={() => setDetailsOpen(true)} size="sm" type="button" variant="text">
              {text.learnMore}
            </Button>
          )}
        </AppStartDialog>
      )}
      {optionalConnect && (
        <div className="mx-auto mb-2 flex w-[min(42rem,calc(100%-2rem))] justify-end" data-app-bot-setup={app.app}>
          <Button disabled={pending} onClick={() => void connectAccount()} size="sm" type="button" variant="text">
            {guestText.connect}
          </Button>
        </div>
      )}
      {needsConsent && (
        <Dialog onOpenChange={setDetailsOpen} open={detailsOpen}>
          <DialogContent
            // Only the contained reader has a description line; the shared disclosure opts out of the warning.
            {...(containedAppCopy ? {} : { 'aria-describedby': undefined })}
            className="max-h-[min(44rem,calc(100vh-3rem))] max-w-xl overflow-y-auto"
          >
            <DialogHeader>
              <DialogTitle>{containedAppCopy ? containedAppCopy.termsTitle : text.title(bot.display_name)}</DialogTitle>
              {containedAppCopy && <DialogDescription>{containedAppCopy.termsVersion}</DialogDescription>}
            </DialogHeader>
            {containedAppCopy && <p className="text-sm text-(--atum-ink-soft)">{containedAppCopy.consent}</p>}
            <ol
              className="list-decimal space-y-3 ps-5 text-sm text-(--atum-ink-soft)"
              {...(containedAppCopy ? { 'data-app-bot-terms': true } : { 'data-app-bot-disclosure': true })}
            >
              {terms.map(term => <li key={term}>{term}</li>)}
            </ol>
            <DialogFooter>
              <Button onClick={() => setDetailsOpen(false)} type="button" variant="secondary">{containedCopy.close}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      <DmIntakeDialog
        appId={app.app_id}
        appName={bot.display_name}
        client={intakeClient}
        onComplete={finishIntake}
        onOpenChange={setIntakeOpen}
        open={intakeOpen}
      />
    </>
  )
}
