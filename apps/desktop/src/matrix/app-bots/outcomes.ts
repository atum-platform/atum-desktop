export type AppBotOutcomeState = 'none' | 'pending' | 'answered' | 'undeliverable' | 'notice'

export interface AppBotOutcome {
  profile: 'atum.app-bot-outcome/1'
  state: AppBotOutcomeState
  code: string | null
  action:
    | { kind: 'open_setup' | 'open_app_route' | 'open_bot_dm' | 'connect_account'; app: string; route_id?: string }
    | { kind: 'retry_later' | 'wait' | 'acknowledge_unknown' }
    | null
  locale: string
}

type AppBotLocale = 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant'

const outcomeCopy: Record<AppBotLocale, Record<string, (app: string) => string>> = {
  en: {
    joined: app => `${app} is here. Mention @${app} or reply to ${app} to ask. ${app} uses only that message and one message you choose to quote; each question counts against the asker's own ${app} messages.`,
    now_group: () => 'This is now a group. Moon answers only when mentioned or replied to, and uses no one’s chart or memory here.',
    needs_intake: app => `${app} needs your birth date, time and place before answering. Open ${app} to add them.`,
    needs_setup: app => `${app} didn't answer because you haven't set it up. Agree to its terms and start using it; only you can see this.`,
    guest_limit_reached: app => `You've reached the guest message limit for ${app}. Connect your ${app} account to keep chatting.`,
    quota_unavailable: app => `${app} can't check your guest messages right now. This is a temporary problem on our side; please try again in a few minutes.`,
    link_pending: app => `${app} is finishing your account connection. Please send again in a minute.`,
    allowance_exhausted: app => `You've used all your messages with ${app}. Pay in ${app}, then send again.`,
    busy: app => `${app} is still answering your previous message. Please send again in a few seconds.`,
    rate_limited: () => 'You are sending messages quickly. Please wait a few minutes and send again.',
    app_unavailable: app => `${app} is temporarily unavailable. Please try again in a few minutes.`,
    app_timeout: app => `${app} took longer than usual, so the answer could not be posted. If a message was used, contact support@atumplatform.com.`,
    outcome_unknown: app => `${app} may have received this message, but its answer didn't make it back here. The message may have been counted, and Atum is checking. If no answer reaches you, email support@atumplatform.com.`,
    missed_while_offline: app => `${app} was away when you sent this. Please send it again.`,
    sent_before_link: app => `${app} is now connected to your account. This message was sent before that, so please send it again.`,
    unsupported_content: app => `${app} can only read text messages for now.`,
    message_too_long: app => `That message is too long for ${app}. Please split it and send it again.`,
    cannot_read: app => `${app} couldn't read this message. Please update Atum and send it again.`,
    unverified_sender: app => `${app} only answers messages from a Mac verified on your account. Verify this Mac in Atum Settings.`,
    andy_group_declined: () => 'Andy only chats one-on-one for now. You can message Andy here.',
    groups_unavailable: app => `${app} only chats one-on-one. Open a private chat with ${app}.`,
    undeliverable: app => `${app} answered, but the answer could not be posted in the group.`,
    no_turn: app => `${app} hasn't answered this message. Make sure Atum is up to date, then try again in a few minutes.`
  },
  vi: {
    joined: app => `${app} đã vào nhóm. Nhắc @${app} hoặc trả lời tin của ${app} để hỏi. ${app} chỉ dùng tin nhắn đó và một tin bạn chọn trích dẫn; mỗi câu hỏi tính vào lượt ${app} của chính người hỏi.`,
    now_group: () => 'Đây giờ là nhóm. Moon chỉ trả lời khi được nhắc hoặc khi bạn trả lời tin của Moon, và không dùng lá số hay ký ức của ai ở đây.',
    needs_intake: app => `${app} cần ngày, giờ và nơi sinh của bạn trước khi trả lời. Hãy mở ${app} để điền.`,
    needs_setup: app => `${app} chưa trả lời vì bạn chưa bắt đầu. Hãy đồng ý điều khoản và bắt đầu dùng ${app}; chỉ bạn thấy thông báo này.`,
    guest_limit_reached: app => `Bạn đã dùng hết lượt nhắn khách với ${app}. Hãy kết nối tài khoản ${app} để tiếp tục trò chuyện.`,
    quota_unavailable: app => `${app} chưa kiểm tra được lượt nhắn khách lúc này. Đây là sự cố tạm thời từ phía chúng tôi; bạn thử lại sau ít phút nhé.`,
    link_pending: app => `${app} đang hoàn tất kết nối tài khoản của bạn. Bạn gửi lại sau một phút nhé.`,
    allowance_exhausted: app => `Bạn đã dùng hết lượt nhắn với ${app}. Hãy thanh toán trong ${app}, rồi gửi lại.`,
    busy: app => `${app} vẫn đang trả lời tin trước của bạn. Bạn gửi lại sau ít giây nhé.`,
    rate_limited: () => 'Bạn đang nhắn hơi nhanh. Bạn đợi vài phút rồi gửi lại nhé.',
    app_unavailable: app => `${app} đang tạm gián đoạn. Bạn thử lại sau ít phút nhé.`,
    app_timeout: app => `${app} trả lời lâu hơn bình thường nên chưa gửi được câu trả lời. Nếu lượt nhắn đã bị trừ mà không có câu trả lời, hãy liên hệ support@atumplatform.com.`,
    outcome_unknown: app => `${app} có thể đã nhận tin này nhưng câu trả lời không về được đây. Lượt nhắn có thể đã được tính và Atum đang kiểm tra lại. Nếu bạn không nhận được câu trả lời, hãy báo support@atumplatform.com.`,
    missed_while_offline: app => `Xin lỗi, ${app} tạm vắng lúc bạn nhắn. Bạn gửi lại tin nhắn nhé.`,
    sent_before_link: app => `${app} đã kết nối với tài khoản của bạn. Tin này được gửi trước khi kết nối, bạn gửi lại nhé.`,
    unsupported_content: app => `${app} hiện chỉ đọc được tin nhắn chữ.`,
    message_too_long: app => `Tin nhắn dài quá để ${app} đọc. Bạn chia nhỏ rồi gửi lại nhé.`,
    cannot_read: app => `${app} chưa đọc được tin nhắn này. Bạn cập nhật Atum rồi gửi lại nhé.`,
    unverified_sender: app => `${app} chỉ trả lời tin nhắn từ máy đã được xác minh trong tài khoản của bạn. Hãy xác minh máy này trong Cài đặt Atum.`,
    andy_group_declined: () => 'Andy chỉ trò chuyện riêng nên chưa thể vào nhóm. Bạn cứ nhắn cho Andy ở đây nhé.',
    groups_unavailable: app => `${app} chỉ trò chuyện riêng. Hãy mở chat riêng với ${app}.`,
    undeliverable: app => `${app} đã trả lời nhưng chưa gửi được câu trả lời vào nhóm.`,
    no_turn: app => `${app} chưa trả lời tin này. Hãy kiểm tra Atum đã được cập nhật, rồi thử lại sau ít phút.`
  },
  ja: {
    joined: app => `${app} が参加しました。@${app}へのメンションまたは${app}への返信で質問できます。${app} はそのメッセージと、あなたが選んだ引用1件だけを使います。`,
    now_group: () => 'このチャットはグループになりました。MoonはメンションまたはMoonへの返信にだけ答え、ここでは誰のチャートや記憶も使いません。',
    needs_intake: app => `${app} が回答するには生年月日、時刻、出生地が必要です。${app}を開いて入力してください。`,
    needs_setup: app => `${app} はまだ回答していません。利用条件に同意して開始してください。これはあなただけに表示されます。`,
    guest_limit_reached: app => `${app} のゲストメッセージ上限に達しました。${app} アカウントを接続すると続けられます。`,
    quota_unavailable: app => `${app} は現在ゲストメッセージを確認できません。こちら側の一時的な問題です。数分後にもう一度お試しください。`,
    link_pending: app => `${app} はアカウント接続を完了しています。1分後にもう一度送信してください。`,
    allowance_exhausted: app => `${app}のメッセージを使い切りました。${app}で支払ってからもう一度送信してください。`,
    busy: app => `${app} は前のメッセージに回答中です。少し待ってからもう一度送信してください。`,
    rate_limited: () => '送信が速すぎます。数分待ってからもう一度送信してください。',
    app_unavailable: app => `${app} は一時的に利用できません。数分後にもう一度お試しください。`,
    app_timeout: app => `${app} の回答に時間がかかり、グループに投稿できませんでした。`,
    outcome_unknown: app => `${app} がこのメッセージを受け取った可能性がありますが、回答がここに届きませんでした。メッセージ数に数えられた可能性があり、Atum が確認しています。回答が届かない場合は support@atumplatform.com までご連絡ください。`,
    missed_while_offline: app => `${app} はメッセージ送信時に不在でした。もう一度送信してください。`,
    sent_before_link: app => `${app} は現在アカウントに接続されています。このメッセージは接続前に送られました。`,
    unsupported_content: app => `${app} は現在テキストメッセージだけを読めます。`,
    message_too_long: app => `このメッセージは${app}が読むには長すぎます。分けて送信してください。`,
    cannot_read: app => `${app} はこのメッセージを読めませんでした。Atumを更新してもう一度送信してください。`,
    unverified_sender: app => `${app} はアカウントで確認済みのMacからのメッセージだけに回答します。Atum設定でこのMacを確認してください。`,
    andy_group_declined: () => 'Andyは1対1のチャットのみ対応しています。ここでAndyにメッセージできます。',
    groups_unavailable: app => `${app} は1対1のチャットのみ対応しています。プライベートチャットを開いてください。`,
    undeliverable: app => `${app} は回答しましたが、グループに投稿できませんでした。`,
    no_turn: app => `${app} はこのメッセージにまだ返信していません。Atumを更新してから後でもう一度お試しください。`
  },
  zh: {
    joined: app => `${app} 已加入群组。提及 @${app} 或回复 ${app} 即可提问。${app} 只使用该消息和您选择引用的一条消息。`,
    now_group: () => '这里现在是群组。Moon 只会在被提及或收到回复时回答，并且不会使用任何人的星盘或记忆。',
    needs_intake: app => `${app} 需要您的出生日期、时间和地点才能回答。请打开 ${app} 填写。`,
    needs_setup: app => `${app} 尚未回答，因为您还没有开始。请同意条款并开始使用；只有您能看到此消息。`,
    guest_limit_reached: app => `您已达到 ${app} 的访客消息上限。请连接您的 ${app} 账户以继续聊天。`,
    quota_unavailable: app => `${app} 目前无法检查访客消息。这是我们这边的临时问题；请几分钟后再试。`,
    link_pending: app => `${app} 正在完成账户连接。请一分钟后再发送。`,
    allowance_exhausted: app => `您已用完 ${app} 的消息额度。请在 ${app} 中付费后再发送。`,
    busy: app => `${app} 仍在回复您之前的消息。请稍后再发送。`,
    rate_limited: () => '您发送得太快了。请等待几分钟后再发送。',
    app_unavailable: app => `${app} 暂时不可用。请稍后再试。`,
    app_timeout: app => `${app} 回复时间过长，无法发布到群组。`,
    outcome_unknown: app => `${app} 可能已收到这条消息，但回答没有送达这里。这条消息可能已被计入，Atum 正在核查。若始终没有收到回答，请联系 support@atumplatform.com。`,
    missed_while_offline: app => `${app} 在您发送时离线。请再发送一次。`,
    sent_before_link: app => `${app} 现已连接到您的账户。这条消息在连接前发送。`,
    unsupported_content: app => `${app} 目前只能读取文字消息。`,
    message_too_long: app => `这条消息太长，${app} 无法读取。请拆分后再发送。`,
    cannot_read: app => `${app} 无法读取这条消息。请更新 Atum 后再发送。`,
    unverified_sender: app => `${app} 只会回复来自您账户已验证 Mac 的消息。请在 Atum 设置中验证此 Mac。`,
    andy_group_declined: () => 'Andy 目前仅支持一对一聊天。您可以在这里私信 Andy。',
    groups_unavailable: app => `${app} 仅支持一对一聊天。请打开私聊。`,
    undeliverable: app => `${app} 已回答，但无法发布到群组。`,
    no_turn: app => `${app} 尚未回复这条消息。请确认 Atum 已更新后稍后再试。`
  },
  'zh-hant': {
    joined: app => `${app} 已加入群組。提及 @${app} 或回覆 ${app} 即可提問。${app} 只使用該訊息和您選擇引用的一則訊息。`,
    now_group: () => '這裡現在是群組。Moon 只會在被提及或收到回覆時回答，並且不會使用任何人的星盤或記憶。',
    needs_intake: app => `${app} 需要您的出生日期、時間和地點才能回答。請開啟 ${app} 填寫。`,
    needs_setup: app => `${app} 尚未回答，因為您還沒有開始。請同意條款並開始使用；只有您能看到此訊息。`,
    guest_limit_reached: app => `您已達到 ${app} 的訪客訊息上限。請連結您的 ${app} 帳戶以繼續聊天。`,
    quota_unavailable: app => `${app} 目前無法檢查訪客訊息。這是我們這邊的暫時問題；請幾分鐘後再試。`,
    link_pending: app => `${app} 正在完成帳戶連結。請一分鐘後再傳送。`,
    allowance_exhausted: app => `您已用完 ${app} 的訊息額度。請在 ${app} 中付費後再傳送。`,
    busy: app => `${app} 仍在回覆您之前的訊息。請稍後再傳送。`,
    rate_limited: () => '您傳送得太快了。請等待幾分鐘後再傳送。',
    app_unavailable: app => `${app} 暫時無法使用。請稍後再試。`,
    app_timeout: app => `${app} 回覆時間過長，無法發佈到群組。`,
    outcome_unknown: app => `${app} 可能已收到這則訊息，但回答沒有送達這裡。這則訊息可能已被計入，Atum 正在核查。若一直沒有收到回答，請聯絡 support@atumplatform.com。`,
    missed_while_offline: app => `${app} 在您傳送時離線。請再傳送一次。`,
    sent_before_link: app => `${app} 現已連結到您的帳戶。這則訊息在連結前傳送。`,
    unsupported_content: app => `${app} 目前只能讀取文字訊息。`,
    message_too_long: app => `這則訊息太長，${app} 無法讀取。請拆分後再傳送。`,
    cannot_read: app => `${app} 無法讀取這則訊息。請更新 Atum 後再傳送。`,
    unverified_sender: app => `${app} 只會回覆來自您帳戶已驗證 Mac 的訊息。請在 Atum 設定中驗證此 Mac。`,
    andy_group_declined: () => 'Andy 目前只支援一對一聊天。您可以在這裡私訊 Andy。',
    groups_unavailable: app => `${app} 只支援一對一聊天。請開啟私人聊天。`,
    undeliverable: app => `${app} 已回答，但無法發佈到群組。`,
    no_turn: app => `${app} 尚未回覆這則訊息。請確認 Atum 已更新後稍後再試。`
  }
}

/** A catalog slug ("the-space") as a name ("The Space"); a display name is already one. */
function appNameOf(app: string): string {
  return /^[a-z][a-z0-9_-]*$/u.test(app)
    ? app.replace(/(^|[_-])([a-z])/gu, (_match, gap: string, letter: string) => `${gap ? ' ' : ''}${letter.toUpperCase()}`)
    : app
}

/** Private outcomes are translated for the viewer, never from untrusted notice body text. */
export function appBotOutcomeText(locale: string | undefined, code: string | null, app: string): string {
  const language: AppBotLocale = locale === 'vi' || locale === 'ja' || locale === 'zh' || locale === 'zh-hant' ? locale : 'en'
  const name = appNameOf(app)
  return outcomeCopy[language][code ?? 'no_turn']?.(name) ?? outcomeCopy[language].no_turn(name)
}

/** The bot an outcome is read for: its app's catalog slug, and whether the catalog calls it guest-enabled. */
export interface AppBotOutcomeBot {
  app: string
  guest: boolean
}

const ROUTE_ID = /^[a-z][a-z0-9_-]{0,63}$/u

/**
 * Decode the platform's per-person outcome, never treating an unprofiled object as a turn result.
 * What gives an action its authority is read and checked: its kind; the app it names, which is the
 * bot's own; for a route, a route id; for a recovery action, the code it answers. Any other field,
 * at the outcome or in the action, is ignored and does not survive the parse, so the platform can
 * add fields without an older Atum refusing the answer.
 */
export function parseAppBotOutcome(value: unknown, bot: AppBotOutcomeBot): AppBotOutcome {
  const raw = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  const action = raw?.action !== null && typeof raw?.action === 'object' && !Array.isArray(raw.action)
    ? raw.action as Record<string, unknown>
    : null
  const appAction =
    action &&
    (action.kind === 'open_setup' || action.kind === 'open_bot_dm' || action.kind === 'open_app_route' || action.kind === 'connect_account') &&
    action.app === bot.app &&
    (action.kind !== 'open_app_route' || (typeof action.route_id === 'string' && ROUTE_ID.test(action.route_id)))
  // A recovery action names no app; if one is named anyway, it is this bot's own or the action is refused.
  const noAppAction =
    action &&
    (action.kind === 'retry_later' || action.kind === 'wait' || action.kind === 'acknowledge_unknown') &&
    (action.app === undefined || action.app === bot.app)
  const validAction = Boolean(appAction || noAppAction)
  const guestActionKind = raw?.code === 'guest_limit_reached'
    ? 'connect_account'
    : raw?.code === 'quota_unavailable'
      ? 'retry_later'
      : raw?.code === 'busy'
        ? 'wait'
        : raw?.code === 'outcome_unknown'
          ? 'acknowledge_unknown'
          : null
  const guestActionValid = !action || action.kind !== 'connect_account' && !noAppAction || (
    action.kind === guestActionKind &&
    // Connect is the way past a guest limit: only a guest-enabled bot has one, and it is its own app's.
    (action.kind !== 'connect_account' || (bot.guest && action.app === bot.app))
  )

  if (
    raw?.profile !== 'atum.app-bot-outcome/1' ||
    (raw.state !== 'none' && raw.state !== 'pending' && raw.state !== 'answered' && raw.state !== 'undeliverable' && raw.state !== 'notice') ||
    (raw.code !== null && typeof raw.code !== 'string') ||
    (raw.locale !== 'vi' && raw.locale !== 'en') ||
    (raw.action !== null && (!validAction || !guestActionValid))
  ) {
    throw new Error('app_bot_outcome_invalid')
  }

  return {
    profile: raw.profile,
    state: raw.state,
    code: raw.code,
    action: action
      ? appAction
        ? {
            kind: action.kind as 'open_setup' | 'open_app_route' | 'open_bot_dm' | 'connect_account',
            app: bot.app,
            ...(action.kind === 'open_app_route' ? { route_id: action.route_id as string } : {})
          }
        : { kind: action.kind as 'retry_later' | 'wait' | 'acknowledge_unknown' }
      : null,
    locale: raw.locale
  }
}

/** The line a poll that could not read an answer leaves in the console: a closed code, never the answer. */
export function appBotOutcomeUnreadableLine(error: unknown): string {
  const text = error instanceof Error ? error.message : ''

  return `[Matrix] app bot outcome unreadable code=${/^[a-z][a-z_]{0,63}$/u.test(text) ? text : 'failed'}`
}

// Intervals between the contract's elapsed poll times: 2, 5, 10, 20, 40, 80, 130 seconds.
export const APP_BOT_OUTCOME_DELAYS = [2_000, 3_000, 5_000, 10_000, 20_000, 40_000, 50_000] as const

/**
 * Poll after a person's own addressed group message; no existence is exposed for anybody else.
 * An answer that cannot be read (the platform sent something this Atum does not understand, or the
 * read failed) is handed to `onError` and polling goes on to the next time on the contract's
 * schedule; if nothing can be read the person gets the "no answer" notice at the end, never silence.
 */
export async function pollAppBotOutcome(
  read: () => Promise<AppBotOutcome>,
  wait: (milliseconds: number) => Promise<void>,
  onUpdate: (outcome: AppBotOutcome) => void,
  now: () => number = () => performance.now(),
  onError?: (error: unknown) => void
): Promise<AppBotOutcome> {
  let outcome: AppBotOutcome = { profile: 'atum.app-bot-outcome/1', state: 'none', code: null, action: null, locale: 'en' }
  const startedAt = now()
  let pollAt = 0

  for (const delay of APP_BOT_OUTCOME_DELAYS) {
    pollAt += delay
    await wait(Math.max(0, startedAt + pollAt - now()))

    try {
      outcome = await read()
    } catch (error) {
      onError?.(error)

      continue
    }

    onUpdate(outcome)

    if (outcome.state === 'answered' || outcome.state === 'undeliverable' || outcome.state === 'notice') {
      return outcome
    }
  }

  return { ...outcome, state: 'notice', code: 'no_turn' }
}
