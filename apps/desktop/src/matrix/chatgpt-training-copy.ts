import { type Locale, useI18n } from '@/i18n'

/**
 * The words of the one-time "training is off" confirmation for using a ChatGPT plan with Google
 * data, and its Settings row. The checkbox and transfer sentences are the server's wording
 * `chatgpt-google-v1` / `chatgpt-google-transfer-v1` character for character (the platform hashes
 * them per language): change them only together with a new wording version. Vietnamese and
 * English are the recorded languages; every other locale reads the English wording, as the
 * platform records it. Never a cost.
 */
export interface ChatGptTrainingCopy {
  /** The card's quiet heading above the checkbox. */
  title: string
  /** Exact v1 wording (hashed by the platform). */
  checkbox: string
  helper: string
  /** Exact transfer disclosure (hashed by the platform); the primary action accepts it. */
  transfer: string
  confirm: string
  keep: string
  saving: string
  failed: string
  stale: string
  /** Settings › Connections, the ChatGPT row's ready line. */
  connectedThisMac: string
  connectedAnotherMac: string
  rowTitle: string
  confirmedOn: (date: string) => string
  notConfirmed: string
  revoke: string
  revoking: string
  revokePending: string
  revokeFailed: string
  readFailed: string
  tryAgain: string
}

const en: ChatGptTrainingCopy = {
  title: 'ChatGPT and your Google data',
  checkbox: 'I turned off ‘Improve the model for everyone’ in ChatGPT → Settings → Data controls.',
  helper:
    'This lets this assistant use your ChatGPT plan with Google data. Keep it off. If you turn it back on, revoke this confirmation in Connections.',
  transfer: 'Send this assistant’s Google data to OpenAI to answer your requests.',
  confirm: 'Confirm and use ChatGPT',
  keep: 'Keep protected model',
  saving: 'Saving…',
  failed: 'Couldn’t save this. Your model hasn’t changed. Try again.',
  stale: 'Your ChatGPT connection changed. Tick the box again to confirm.',
  connectedThisMac: 'Connected to your ChatGPT plan · used through this Mac',
  connectedAnotherMac: 'Connected to your ChatGPT plan · used through another Mac',
  rowTitle: 'ChatGPT with Google data',
  confirmedOn: date => `Training off, confirmed ${date}`,
  notConfirmed: 'Not confirmed. You’ll be asked once when you choose ChatGPT for an assistant that uses Google.',
  revoke: 'Revoke',
  revoking: 'Revoking…',
  revokePending: 'A reply that was already running is still finishing. Try again in a moment.',
  revokeFailed: 'Couldn’t revoke right now. Try again.',
  readFailed: 'Couldn’t check this right now.',
  tryAgain: 'Try again'
}

const vi: ChatGptTrainingCopy = {
  title: 'ChatGPT và dữ liệu Google của bạn',
  checkbox: 'Tôi đã tắt ‘Improve the model for everyone’ trong ChatGPT → Settings → Data controls.',
  helper:
    'Việc này cho phép trợ lý dùng gói ChatGPT của bạn với dữ liệu Google. Hãy giữ cài đặt này ở trạng thái tắt. Nếu bật lại, hãy thu hồi xác nhận trong Kết nối.',
  transfer: 'Gửi dữ liệu Google của trợ lý này đến OpenAI để trả lời yêu cầu của bạn.',
  confirm: 'Xác nhận và dùng ChatGPT',
  keep: 'Giữ mô hình được bảo vệ',
  saving: 'Đang lưu…',
  failed: 'Chưa lưu được. Mô hình của bạn chưa đổi. Hãy thử lại.',
  stale: 'Kết nối ChatGPT đã thay đổi. Hãy đánh dấu lại để xác nhận.',
  connectedThisMac: 'Đã kết nối với gói ChatGPT của bạn · dùng qua máy Mac này',
  connectedAnotherMac: 'Đã kết nối với gói ChatGPT của bạn · dùng qua một máy Mac khác',
  rowTitle: 'ChatGPT với dữ liệu Google',
  confirmedOn: date => `Đã tắt huấn luyện, xác nhận ngày ${date}`,
  notConfirmed: 'Chưa xác nhận. Atum sẽ hỏi một lần khi bạn chọn ChatGPT cho trợ lý có dùng Google.',
  revoke: 'Thu hồi',
  revoking: 'Đang thu hồi…',
  revokePending: 'Một câu trả lời đang chạy vẫn chưa xong. Hãy thử lại sau giây lát.',
  revokeFailed: 'Chưa thu hồi được. Hãy thử lại.',
  readFailed: 'Chưa kiểm tra được lúc này.',
  tryAgain: 'Thử lại'
}

const COPY: Record<Locale, ChatGptTrainingCopy> = { en, vi, ja: en, zh: en, 'zh-hant': en }

export function useChatGptTrainingCopy(): ChatGptTrainingCopy {
  return COPY[useI18n().locale] ?? en
}
