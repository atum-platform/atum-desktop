import type { DesktopLocale } from './desktop-locale'

/**
 * The words of one-tap approval (electron/matrix/device-approval.ts): the new Mac's card, the
 * other device's sheet, and its notification. `{device}` is a device's own name, never its ID.
 */
export interface MatrixApprovalCopy {
  requestWaiting: (device: string) => string
  requestCompare: (device: string) => string
  /** The new Mac's one tap once the person picked its number code on the other device (a Mac with
   * nothing to check the person's identity against confirms only then). */
  picked: string
  /** Beside that tap: it has to come within about a minute of the pick, or the comparison ends
   * (the Matrix SAS timeout). */
  pickedHint: string
  slow: string
  unlocking: string
  done: string
  mismatch: string
  declined: string
  /** The comparison took too long (either side); both sides offer Try again. */
  timeout: string
  failed: string
  tryAgain: string
  useKey: string
  noOtherDevice: string
  noOtherDeviceHelp: string
  /** A device without a name of its own, seen from the new Mac. */
  otherDevice: string
  approveTitle: string
  approveBody: string
  /** Before the person says it is them. */
  approveAsk: string
  itsMe: string
  approveWaiting: string
  none: string
  footer: string
  notMe: string
  sending: string
  /** The approving sheet once the person picked the right row: the rows go, and the new device
   * waits for its "I picked them". `device` is that device's own name, when it has one. */
  approveTapThere: (device: string | undefined) => string
  approved: (device: string) => string
  /** A wrong row: refused, with the same advice as "This wasn't me" (the sheet offers to sign
   * that device out). */
  approveMismatch: string
  approveDeclined: string
  /** This Mac could not approve that device (its own part did not finish). Names no button on
   * the other device and promises no new prompt. `device` is that device's own name, when it has
   * one. The sheet's one button closes it. */
  approveFailed: (device: string | undefined) => string
  /** This Mac approved that device, but it never finished there: only its older messages may stay
   * closed. Names no button on the other device and promises no new prompt. */
  approveUnfinished: (device: string | undefined) => string
  /** One of the sheet's buttons did not go through (the bridge refused or failed). */
  actionFailed: string
  signThatOut: string
  close: string
  notifyTitle: string
  notifyBody: string
  /** A device without a name of its own, seen from the approving device. */
  newDevice: string
  /** The key form, when the key this Mac kept no longer opens the account's recovery: it was
   * changed elsewhere (Atum never changes it by itself). */
  keyStale: string
}

const en: MatrixApprovalCopy = {
  requestWaiting: device => `Open Atum on ${device}. A request appears there.`,
  requestCompare: device => `Open Atum on ${device} and pick this number code within a minute:`,
  picked: 'I picked this code',
  pickedHint: 'Then come back and tap “I picked this code” within a minute.',
  slow: 'No answer yet. Your other device needs to be on, online and running Atum.',
  unlocking: 'Unlocking this Mac…',
  done: 'Your messages and assistants are unlocked on this Mac.',
  mismatch: 'That didn’t match, so this Mac wasn’t approved.',
  declined: 'Your other device declined.',
  timeout: 'That took too long — try again.',
  failed: 'The key didn’t arrive from your other device.',
  tryAgain: 'Try again',
  useKey: 'Use recovery key',
  noOtherDevice: 'I don’t have another device',
  noOtherDeviceHelp: 'Use the recovery key you saved, usually in a password manager or your notes.',
  otherDevice: 'your other device',
  approveTitle: 'Did you just sign in on a new device?',
  approveBody:
    'Pick the number code showing on that device. It will then be able to read your messages and use your assistants.',
  approveAsk: 'That device is asking to read your messages and use your assistants.',
  itsMe: 'Yes, it’s me',
  approveWaiting: 'Connecting to that device…',
  none: 'None of these match',
  footer: 'Atum will never call or message you asking you to pick a number code.',
  notMe: 'This wasn’t me',
  sending: 'Sending the key to that device…',
  approveTapThere: device => `Now tap “I picked this code” on ${device ?? 'that device'}.`,
  approved: device => `${device} is approved.`,
  approveMismatch:
    'That didn’t match, so the device wasn’t approved. If it wasn’t you, change your Google password and sign that device out.',
  approveDeclined: 'Declined. If it wasn’t you, change your Google password and sign that device out.',
  approveFailed: device => `Couldn’t approve ${device ?? 'that device'}. Try again in a few minutes.`,
  approveUnfinished: device => `Approved ${device ?? 'that device'}, but older messages may not open there yet.`,
  actionFailed: 'That didn’t go through. Try again.',
  signThatOut: 'Sign that device out',
  close: 'Close',
  notifyTitle: 'A new device wants to unlock your messages',
  notifyBody: 'Open Atum to approve or decline it.',
  newDevice: 'A new device',
  keyStale:
    'Your account’s security was changed from another device or sign-in. If that wasn’t you, change your Google password.'
}

const vi: MatrixApprovalCopy = {
  requestWaiting: device => `Mở Atum trên ${device}. Một yêu cầu sẽ hiện ở đó.`,
  requestCompare: device => `Mở Atum trên ${device} rồi chọn mã số này trong vòng một phút:`,
  picked: 'Tôi đã chọn mã này',
  pickedHint: 'Sau đó quay lại đây và bấm “Tôi đã chọn mã này” trong vòng một phút.',
  slow: 'Chưa thấy máy kia trả lời. Máy đó cần đang bật, có mạng và mở Atum.',
  unlocking: 'Đang mở khóa Mac này…',
  done: 'Đã mở khóa tin nhắn và trợ lý trên Mac này.',
  mismatch: 'Không khớp, nên Mac này chưa được cho phép.',
  declined: 'Máy kia đã từ chối.',
  timeout: 'Mất quá lâu — hãy thử lại.',
  failed: 'Chưa nhận được khóa từ máy kia.',
  tryAgain: 'Thử lại',
  useKey: 'Dùng khóa khôi phục',
  noOtherDevice: 'Tôi không còn máy nào khác',
  noOtherDeviceHelp: 'Hãy dùng khóa khôi phục bạn đã lưu, thường trong trình quản lý mật khẩu hoặc ghi chú.',
  otherDevice: 'máy khác của bạn',
  approveTitle: 'Bạn vừa đăng nhập trên một máy mới?',
  approveBody: 'Chọn mã số đang hiện trên máy đó. Sau đó máy đó sẽ đọc được tin nhắn và dùng được trợ lý của bạn.',
  approveAsk: 'Máy đó đang xin quyền đọc tin nhắn và dùng trợ lý của bạn.',
  itsMe: 'Đúng, là tôi',
  approveWaiting: 'Đang kết nối với máy đó…',
  none: 'Không hàng nào khớp',
  footer: 'Atum không bao giờ gọi điện hay nhắn tin bảo bạn chọn mã số.',
  notMe: 'Không phải tôi',
  sending: 'Đang gửi khóa đến máy đó…',
  approveTapThere: device => `Giờ hãy bấm “Tôi đã chọn mã này” trên ${device ?? 'máy đó'}.`,
  approved: device => `Đã cho phép ${device}.`,
  approveMismatch:
    'Không khớp, nên máy đó chưa được cho phép. Nếu không phải bạn, hãy đổi mật khẩu Google rồi đăng xuất máy đó.',
  approveDeclined: 'Đã từ chối. Nếu không phải bạn, hãy đổi mật khẩu Google rồi đăng xuất máy đó.',
  approveFailed: device => `Chưa cho phép được ${device ?? 'máy đó'}. Hãy thử lại sau ít phút.`,
  approveUnfinished: device => `Đã cho phép ${device ?? 'máy đó'}, nhưng tin nhắn cũ có thể chưa mở được ở đó.`,
  actionFailed: 'Chưa làm được. Hãy thử lại.',
  signThatOut: 'Đăng xuất máy đó',
  close: 'Đóng',
  notifyTitle: 'Có máy mới muốn mở khóa tin nhắn của bạn',
  notifyBody: 'Mở Atum để cho phép hoặc từ chối.',
  newDevice: 'Một máy mới',
  keyStale:
    'Bảo mật tài khoản của bạn đã được thay đổi từ một máy khác hoặc một lần đăng nhập khác. Nếu không phải bạn, hãy đổi mật khẩu Google.'
}

const ja: MatrixApprovalCopy = {
  requestWaiting: device => `${device}で Atum を開いてください。そこに確認が表示されます。`,
  requestCompare: device => `${device}で Atum を開き、1 分以内にこの番号コードを選んでください:`,
  picked: 'このコードを選びました',
  pickedHint: '選んだら、1 分以内にここで「このコードを選びました」をタップしてください。',
  slow: 'まだ応答がありません。もう一方の端末の電源が入っていて、オンラインで Atum が開いている必要があります。',
  unlocking: 'この Mac のロックを解除しています…',
  done: 'この Mac でメッセージとアシスタントのロックが解除されました。',
  mismatch: '一致しなかったため、この Mac は承認されていません。',
  declined: 'もう一方の端末で拒否されました。',
  timeout: '時間がかかりすぎました。もう一度お試しください。',
  failed: 'もう一方の端末からキーが届きませんでした。',
  tryAgain: 'もう一度試す',
  useKey: '復旧キーを使う',
  noOtherDevice: 'ほかの端末がない',
  noOtherDeviceHelp: '保存した復旧キーを使ってください。多くの場合、パスワード管理アプリやメモにあります。',
  otherDevice: 'ほかの端末',
  approveTitle: '新しい端末でログインしましたか？',
  approveBody:
    'その端末に表示されている番号コードを選んでください。その端末であなたのメッセージを読み、アシスタントを使えるようになります。',
  approveAsk: 'その端末があなたのメッセージを読み、アシスタントを使う許可を求めています。',
  itsMe: 'はい、自分です',
  approveWaiting: 'その端末に接続しています…',
  none: 'どれも一致しない',
  footer: 'Atum が電話やメッセージで番号コードを選ぶよう頼むことはありません。',
  notMe: '自分ではない',
  sending: 'その端末にキーを送っています…',
  approveTapThere: device => `${device ?? 'その端末'}で「このコードを選びました」をタップしてください。`,
  approved: device => `${device}を承認しました。`,
  approveMismatch:
    '一致しなかったため、その端末は承認されていません。自分でない場合は、Google のパスワードを変更してから、その端末をログアウトさせてください。',
  approveDeclined:
    '拒否しました。自分でない場合は、Google のパスワードを変更してから、その端末をログアウトさせてください。',
  approveFailed: device => `${device ?? 'その端末'}を承認できませんでした。数分後にもう一度お試しください。`,
  approveUnfinished: device =>
    `${device ?? 'その端末'}を承認しましたが、そこでは以前のメッセージがまだ開けない場合があります。`,
  actionFailed: 'うまくいきませんでした。もう一度お試しください。',
  signThatOut: 'その端末をログアウト',
  close: '閉じる',
  notifyTitle: '新しい端末がメッセージのロック解除を求めています',
  notifyBody: 'Atum を開いて承認または拒否してください。',
  newDevice: '新しい端末',
  keyStale:
    'アカウントのセキュリティが、別の端末または別のログインから変更されました。自分でない場合は、Google のパスワードを変更してください。'
}

const zh: MatrixApprovalCopy = {
  requestWaiting: device => `请在${device}上打开 Atum，那里会显示一个请求。`,
  requestCompare: device => `请在${device}上打开 Atum，并在一分钟内选择这个数字代码：`,
  picked: '我已选择此代码',
  pickedHint: '选好后，请在一分钟内回到这里点按“我已选择此代码”。',
  slow: '还没有回应。你的另一台设备需要开机、联网并打开 Atum。',
  unlocking: '正在解锁这台 Mac…',
  done: '这台 Mac 上的消息和助手已解锁。',
  mismatch: '不一致，因此这台 Mac 未获批准。',
  declined: '你的另一台设备拒绝了。',
  timeout: '用时太久了，请重试。',
  failed: '没有收到另一台设备发来的密钥。',
  tryAgain: '重试',
  useKey: '使用恢复密钥',
  noOtherDevice: '我没有其他设备',
  noOtherDeviceHelp: '请使用你保存的恢复密钥，通常在密码管理器或笔记里。',
  otherDevice: '你的另一台设备',
  approveTitle: '你刚在一台新设备上登录了吗？',
  approveBody: '选择那台设备上显示的数字代码。之后它就能读取你的消息并使用你的助手。',
  approveAsk: '那台设备正在请求读取你的消息并使用你的助手。',
  itsMe: '是的，是我',
  approveWaiting: '正在连接那台设备…',
  none: '都不一致',
  footer: 'Atum 绝不会打电话或发消息让你选择数字代码。',
  notMe: '不是我',
  sending: '正在把密钥发送到那台设备…',
  approveTapThere: device => `现在请在${device ?? '那台设备'}上点按“我已选择此代码”。`,
  approved: device => `已批准${device}。`,
  approveMismatch: '不一致，因此那台设备未获批准。如果不是你本人，请修改 Google 密码，然后让那台设备退出登录。',
  approveDeclined: '已拒绝。如果不是你本人，请修改 Google 密码，然后让那台设备退出登录。',
  approveFailed: device => `没能批准${device ?? '那台设备'}。请过几分钟再试。`,
  approveUnfinished: device => `已批准${device ?? '那台设备'}，但那里可能还打不开以前的消息。`,
  actionFailed: '没有成功，请重试。',
  signThatOut: '让那台设备退出登录',
  close: '关闭',
  notifyTitle: '有新设备想解锁你的消息',
  notifyBody: '打开 Atum 批准或拒绝。',
  newDevice: '一台新设备',
  keyStale: '你的账户安全设置已在另一台设备或另一次登录中被更改。如果不是你本人，请修改 Google 密码。'
}

const zhHant: MatrixApprovalCopy = {
  requestWaiting: device => `請在${device}上打開 Atum，那裡會顯示一個請求。`,
  requestCompare: device => `請在${device}上打開 Atum，並在一分鐘內選擇這個數字代碼：`,
  picked: '我已選擇此代碼',
  pickedHint: '選好後，請在一分鐘內回到這裡點按「我已選擇此代碼」。',
  slow: '還沒有回應。你的另一台裝置需要開機、連網並打開 Atum。',
  unlocking: '正在解鎖這台 Mac…',
  done: '這台 Mac 上的訊息和助理已解鎖。',
  mismatch: '不一致，因此這台 Mac 未獲核准。',
  declined: '你的另一台裝置拒絕了。',
  timeout: '花了太久時間，請再試一次。',
  failed: '沒有收到另一台裝置傳來的金鑰。',
  tryAgain: '再試一次',
  useKey: '使用復原金鑰',
  noOtherDevice: '我沒有其他裝置',
  noOtherDeviceHelp: '請使用你儲存的復原金鑰，通常在密碼管理工具或筆記裡。',
  otherDevice: '你的另一台裝置',
  approveTitle: '你剛在一台新裝置上登入了嗎？',
  approveBody: '選擇那台裝置上顯示的數字代碼。之後它就能讀取你的訊息並使用你的助理。',
  approveAsk: '那台裝置正在請求讀取你的訊息並使用你的助理。',
  itsMe: '是的，是我',
  approveWaiting: '正在連線那台裝置…',
  none: '都不一致',
  footer: 'Atum 絕不會打電話或傳訊息要你選擇數字代碼。',
  notMe: '不是我',
  sending: '正在把金鑰傳送到那台裝置…',
  approveTapThere: device => `現在請在${device ?? '那台裝置'}上點按「我已選擇此代碼」。`,
  approved: device => `已核准${device}。`,
  approveMismatch: '不一致，因此那台裝置未獲核准。如果不是你本人，請修改 Google 密碼，然後讓那台裝置登出。',
  approveDeclined: '已拒絕。如果不是你本人，請修改 Google 密碼，然後讓那台裝置登出。',
  approveFailed: device => `沒能核准${device ?? '那台裝置'}。請過幾分鐘再試一次。`,
  approveUnfinished: device => `已核准${device ?? '那台裝置'}，但那裡可能還打不開以前的訊息。`,
  actionFailed: '沒有成功，請再試一次。',
  signThatOut: '讓那台裝置登出',
  close: '關閉',
  notifyTitle: '有新裝置想解鎖你的訊息',
  notifyBody: '打開 Atum 核准或拒絕。',
  newDevice: '一台新裝置',
  keyStale: '你的帳號安全設定已在另一台裝置或另一次登入中被變更。如果不是你本人，請修改 Google 密碼。'
}

const copies: Record<DesktopLocale, MatrixApprovalCopy> = { en, vi, ja, zh, 'zh-hant': zhHant }

export function matrixApprovalCopy(locale: DesktopLocale): MatrixApprovalCopy {
  return copies[locale]
}
