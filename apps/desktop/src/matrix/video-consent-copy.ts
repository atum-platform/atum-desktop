import { type Locale, useI18n } from '@/i18n'

import type { MatrixVideoConsentLocale } from '../../shared/matrix-video-consent'

/**
 * The consent sentences of wording `minimax-video-v1`, character for character, in the languages
 * the platform records them in (it hashes each sentence). The card shows the language the server
 * names (`locale`), whatever the app's language is. Change them only together with a new wording
 * version the platform has agreed. Never a cost.
 */
export const MATRIX_VIDEO_CONSENT_SENTENCES: Record<MatrixVideoConsentLocale, { checkbox: string; disclosure: string }> = {
  en: {
    checkbox:
      'I agree that Atum may send my video-generation prompts and any images I provide to MiniMax through OpenRouter to make videos.',
    disclosure:
      'MiniMax keeps video prompts, input images and generated videos for a time to process and deliver each job. Zero data retention is not available for video generation. My other Atum chats keep zero data retention.'
  },
  vi: {
    checkbox:
      'Tôi đồng ý để Atum gửi câu lệnh tạo video và mọi hình ảnh tôi cung cấp đến MiniMax qua OpenRouter để tạo video.',
    disclosure:
      'MiniMax lưu câu lệnh video, hình ảnh đầu vào và video được tạo trong một thời gian để xử lý và trả kết quả. Tính năng không lưu dữ liệu (ZDR) không áp dụng cho tạo video. Các cuộc trò chuyện Atum khác của tôi vẫn được bảo vệ không lưu dữ liệu.'
  }
}

/** The app's own words around those sentences (buttons, titles, states), in the app's language. */
export interface VideoConsentCopy {
  title: string
  allow: string
  dismiss: string
  saving: string
  allowed: string
  refused: string
  unavailable: string
  tryAgain: string
  /** Settings › Connections. */
  section: string
  switchLabel: string
  allowedOn: (date: string) => string
  off: string
  turningOff: string
  turnOffPending: string
  turnOffFailed: string
  readFailed: string
}

const en: VideoConsentCopy = {
  title: 'Allow video generation?',
  allow: 'Allow video',
  dismiss: 'Not now',
  saving: 'Saving…',
  allowed: 'Video is allowed.',
  refused: 'Video can’t be allowed for this account right now.',
  unavailable: 'Couldn’t reach Atum. Nothing was changed.',
  tryAgain: 'Try again',
  section: 'Video generation',
  switchLabel: 'Allow video generation',
  allowedOn: date => `Allowed ${date}`,
  off: 'Off. You’ll be asked once, the first time an assistant makes a video.',
  turningOff: 'Turning off…',
  turnOffPending: 'Still turning off. Try again in a moment.',
  turnOffFailed: 'Couldn’t turn this off right now. Try again.',
  readFailed: 'Couldn’t check this right now.'
}

const vi: VideoConsentCopy = {
  title: 'Cho phép tạo video?',
  allow: 'Cho phép tạo video',
  dismiss: 'Để sau',
  saving: 'Đang lưu…',
  allowed: 'Đã cho phép tạo video.',
  refused: 'Hiện chưa thể cho phép tạo video cho tài khoản này.',
  unavailable: 'Chưa kết nối được với Atum. Chưa có gì thay đổi.',
  tryAgain: 'Thử lại',
  section: 'Tạo video',
  switchLabel: 'Cho phép tạo video',
  allowedOn: date => `Đã cho phép ngày ${date}`,
  off: 'Chưa bật. Atum sẽ hỏi một lần, vào lần đầu trợ lý tạo video.',
  turningOff: 'Đang tắt…',
  turnOffPending: 'Vẫn đang tắt. Hãy thử lại sau giây lát.',
  turnOffFailed: 'Chưa tắt được lúc này. Hãy thử lại.',
  readFailed: 'Chưa kiểm tra được lúc này.'
}

const COPY: Record<Locale, VideoConsentCopy> = { en, vi, ja: en, zh: en, 'zh-hant': en }

export function useVideoConsentCopy(): VideoConsentCopy {
  return COPY[useI18n().locale] ?? en
}
