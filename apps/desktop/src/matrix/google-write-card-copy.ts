import type { Locale } from '@/i18n'

import { MATRIX_GOOGLE_WRITE_COPY, type MatrixGoogleWriteLabels } from '../../shared/matrix-google-write-copy'

type Kind = 'send_email' | 'create_event' | 'update_event' | 'drive_create' | 'drive_update'

/**
 * The Google write card's words (docs/google-write-confirmation.md). The question, the confirming
 * button and the field names are the same table the main-process write dialog speaks
 * (`shared/matrix-google-write-copy.ts`); the card adds only its own states. English and
 * Vietnamese; any other language falls back to English, as the app's copy does.
 */
export interface MatrixGoogleWriteCardCopy {
  question: Record<Kind, string>
  approve: Record<Kind, string>
  decline: string
  approving: string
  declining: string
  labels: MatrixGoogleWriteLabels & {
    guests: string
    allDay: string
    timeZone: string
    file: string
    folder: string
    content: string
  }
  /** One calm line per state the card can end in. */
  done: Record<Kind, string>
  approved: string
  declined: string
  superseded: string
  expired: string
  changed: string
  answered: string
  failed: string
  retry: string
}

function from(locale: 'en' | 'vi') {
  const table = MATRIX_GOOGLE_WRITE_COPY[locale]

  return {
    question: {
      send_email: table.message['send-email'],
      create_event: table.message['create-event'],
      update_event: table.message['update-event']
    },
    approve: {
      send_email: table.confirm['send-email'],
      create_event: table.confirm['create-event'],
      update_event: table.confirm['update-event']
    },
    labels: table.labels
  }
}

const en = from('en')
const vi = from('vi')

const copies: Partial<Record<Locale, MatrixGoogleWriteCardCopy>> = {
  en: {
    question: { ...en.question, drive_create: 'Create this file in Drive?', drive_update: 'Save these changes in Drive?' },
    approve: { ...en.approve, drive_create: 'Create file', drive_update: 'Save changes' },
    decline: 'Decline',
    approving: 'Approving…',
    declining: 'Declining…',
    labels: { ...en.labels, guests: 'Guests', allDay: 'All day', timeZone: 'Time zone', file: 'File', folder: 'Folder', content: 'Content' },
    done: {
      send_email: 'Sent.',
      create_event: 'Added to your calendar.',
      update_event: 'Changes saved to your calendar.',
      drive_create: 'Created in Drive.',
      drive_update: 'Changes saved in Drive.'
    },
    approved: 'Approved. It could not be confirmed yet, so check Google before asking again.',
    declined: 'Declined. Nothing changed.',
    superseded: 'A newer request replaced this one. Nothing changed.',
    expired: 'This request expired. Nothing changed.',
    changed: 'This draft changed after it was shown, so it was not sent. Ask for a fresh one.',
    answered: 'This request was already answered.',
    failed: 'This did not go through. Nothing changed. You can ask again.',
    retry: 'Could not reach Atum. Try again.'
  },
  vi: {
    question: { ...vi.question, drive_create: 'Tạo tệp này trong Drive?', drive_update: 'Lưu thay đổi này trong Drive?' },
    approve: { ...vi.approve, drive_create: 'Tạo tệp', drive_update: 'Lưu thay đổi' },
    decline: 'Từ chối',
    approving: 'Đang duyệt…',
    declining: 'Đang từ chối…',
    labels: { ...vi.labels, guests: 'Khách mời', allDay: 'Cả ngày', timeZone: 'Múi giờ', file: 'Tệp', folder: 'Thư mục', content: 'Nội dung' },
    done: {
      send_email: 'Đã gửi.',
      create_event: 'Đã thêm vào lịch.',
      update_event: 'Đã lưu thay đổi vào lịch.',
      drive_create: 'Đã tạo trong Drive.',
      drive_update: 'Đã lưu thay đổi trong Drive.'
    },
    approved: 'Đã duyệt. Chưa xác nhận được kết quả, hãy kiểm tra trên Google trước khi nhờ lại.',
    declined: 'Đã từ chối. Không có gì thay đổi.',
    superseded: 'Một yêu cầu mới hơn đã thay thế yêu cầu này. Không có gì thay đổi.',
    expired: 'Yêu cầu này đã hết hạn. Không có gì thay đổi.',
    changed: 'Bản nháp đã thay đổi sau khi hiển thị nên chưa được gửi. Hãy nhờ soạn lại.',
    answered: 'Yêu cầu này đã được trả lời.',
    failed: 'Chưa thực hiện được. Không có gì thay đổi. Bạn có thể nhờ lại.',
    retry: 'Không kết nối được với Atum. Hãy thử lại.'
  }
}

export function matrixGoogleWriteCardCopy(locale: Locale): MatrixGoogleWriteCardCopy {
  return copies[locale] ?? copies.en!
}
