import type { DesktopLocale } from './desktop-locale'
interface DeviceIsolationCopy {
  sendBlocked: string
  title: string
  help: string
  group: string
  identityChanged: (name: string) => string
  verificationRequired: (name: string) => string
  review: string
  compareHelp: string
  confirmIdentity: string
  continueWithoutVerification: string
  continueHelp: string
  changedAgain: string
}
export const matrixDeviceIsolationCopy: Record<DesktopLocale, DeviceIsolationCopy> = {
  en: {
    sendBlocked: 'Review the identities below before sending again.',
    title: 'Strict device trust (beta)',
    help: 'Only devices signed by their identity can send or receive new messages. Off by default.',
    group: 'Other people’s unverified devices cannot read new messages while strict device trust is on.',
    identityChanged: name => `${name} has a new identity. Review it before sending.`,
    verificationRequired: name => `Review ${name}’s identity before sending again.`,
    review: 'Review identity',
    compareHelp: 'Compare the symbols with this person in the verification prompt. Confirm only when they match.',
    confirmIdentity: 'I compared this identity',
    continueWithoutVerification: 'Continue without previous verification',
    continueHelp:
      'This removes the previous verification requirement for this person. Their devices still need to be signed.',
    changedAgain: 'The identity changed again. Review the current identity before continuing.'
  },
  vi: {
    sendBlocked: 'Hãy kiểm tra các danh tính bên dưới trước khi gửi tiếp.',
    title: 'Tin cậy thiết bị nghiêm ngặt (beta)',
    help: 'Chỉ thiết bị được danh tính của mình ký mới gửi hoặc nhận được tin mới. Mặc định tắt.',
    group: 'Thiết bị chưa được xác minh của người khác không đọc được tin mới khi bật chế độ tin cậy nghiêm ngặt.',
    identityChanged: name => `${name} có danh tính mới. Hãy kiểm tra trước khi gửi.`,
    verificationRequired: name => `Hãy kiểm tra danh tính của ${name} trước khi gửi tiếp.`,
    review: 'Kiểm tra danh tính',
    compareHelp: 'Đối chiếu các biểu tượng với người đó trong yêu cầu xác minh. Chỉ xác nhận khi khớp.',
    confirmIdentity: 'Tôi đã đối chiếu danh tính này',
    continueWithoutVerification: 'Tiếp tục không dùng xác minh trước đây',
    continueHelp: 'Bỏ yêu cầu xác minh trước đây cho người này. Thiết bị của họ vẫn phải được danh tính ký.',
    changedAgain: 'Danh tính lại thay đổi. Hãy kiểm tra danh tính hiện tại trước khi tiếp tục.'
  },
  ja: {
    sendBlocked: '再送信する前に、以下の ID を確認してください。',
    title: '厳格なデバイスの信頼（ベータ）',
    help: '自分の ID で署名されたデバイスだけが新しいメッセージを送受信できます。初期設定はオフです。',
    group: '厳格な信頼がオンの間、相手の未確認デバイスは新しいメッセージを読めません。',
    identityChanged: name => `${name} の ID が変わりました。送信前に確認してください。`,
    verificationRequired: name => `再送信する前に ${name} の ID を確認してください。`,
    review: 'ID を確認',
    compareHelp: '確認画面の記号を相手と比較し、一致する場合のみ承認してください。',
    confirmIdentity: 'この ID を比較しました',
    continueWithoutVerification: '以前の確認を要求せず続ける',
    continueHelp: 'この相手への以前の確認要件を解除します。デバイスには引き続き ID の署名が必要です。',
    changedAgain: 'ID が再び変わりました。続行前に現在の ID を確認してください。'
  },
  zh: {
    sendBlocked: '再次发送前，请核对下方的身份。',
    title: '严格设备信任（测试版）',
    help: '只有被其身份签名的设备才能收发新消息。默认关闭。',
    group: '开启严格设备信任时，其他人的未验证设备无法读取新消息。',
    identityChanged: name => `${name} 的身份已更改。请先核对再发送。`,
    verificationRequired: name => `再次发送前，请核对 ${name} 的身份。`,
    review: '核对身份',
    compareHelp: '在验证提示中与本人比较符号，仅在一致时确认。',
    confirmIdentity: '我已比较此身份',
    continueWithoutVerification: '不要求先前验证并继续',
    continueHelp: '移除此人先前的验证要求，其设备仍须由身份签名。',
    changedAgain: '身份再次更改。请先核对当前身份再继续。'
  },
  'zh-hant': {
    sendBlocked: '再次傳送前，請核對下方的身分。',
    title: '嚴格裝置信任（測試版）',
    help: '只有經其身分簽署的裝置才能收發新訊息。預設關閉。',
    group: '開啟嚴格裝置信任時，其他人的未驗證裝置無法讀取新訊息。',
    identityChanged: name => `${name} 的身分已變更。請先核對再傳送。`,
    verificationRequired: name => `再次傳送前，請核對 ${name} 的身分。`,
    review: '核對身分',
    compareHelp: '在驗證提示中與本人比較符號，僅在一致時確認。',
    confirmIdentity: '我已比較此身分',
    continueWithoutVerification: '不要求先前驗證並繼續',
    continueHelp: '移除此人先前的驗證要求，其裝置仍須由身分簽署。',
    changedAgain: '身分再次變更。請先核對目前身分再繼續。'
  }
}
