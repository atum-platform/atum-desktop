import type { Locale } from '@/i18n'

import { MATRIX_GOOGLE_WRITE_COPY, type MatrixGoogleWriteLabels } from '../../shared/matrix-google-write-copy'
import type { MatrixGoogleMailboxOperation, MatrixGoogleWorkKind } from '../../shared/matrix-google-write-proposal'

/**
 * The Google write card's words (docs/google-write-confirmation.md). The question and the field
 * names are the same table the main-process write dialog speaks (`shared/matrix-google-write-copy.ts`);
 * the card adds only its own actions and states. English and Vietnamese; any other language falls
 * back to English, as the app's copy does.
 *
 * An assistant's approval never sends anything itself (the assistant carries the approved request
 * out), so no agent state says sent, added or saved. Work's approval is carried out by Atum right
 * away, and its outcome reaches Work, not the card, so Work's states say only approved or declined.
 */
export interface MatrixGoogleWriteCardCopy {
  question: Record<Exclude<MatrixGoogleWorkKind, 'mailbox'>, string>
  /** A mailbox change asks per operation. */
  mailbox: Record<MatrixGoogleMailboxOperation, string>
  approve: string
  decline: string
  approving: string
  declining: string
  labels: MatrixGoogleWriteLabels & {
    quote: string
    truncated: string
    name: string
    labels: string
    appliesTo: string
    conversation: string
    oneEmail: string
  }
  /** One calm line per state a card can settle in. */
  approved: string
  declined: string
  superseded: string
  closed: string
  changed: string
  /** Under the actions when Atum could not be reached; the actions stay. */
  retry: string
  /** Work's card: where the request came from, and its own settled lines. */
  work: { source: string; approved: string; declined: string; superseded: string; expired: string; changed: string }
}

function from(locale: 'en' | 'vi') {
  const table = MATRIX_GOOGLE_WRITE_COPY[locale]

  return { message: table.message, labels: table.labels }
}

const en = from('en')
const vi = from('vi')

const copies: Partial<Record<Locale, MatrixGoogleWriteCardCopy>> = {
  en: {
    question: {
      send_email: en.message['send-email'],
      create_event: en.message['create-event'],
      update_event: en.message['update-event'],
      create_draft: 'Save this draft in Gmail?',
      update_draft: 'Update this Gmail draft?',
      create_label: 'Create this Gmail label?'
    },
    mailbox: {
      archive: 'Archive this in Gmail?',
      unarchive: 'Move this back to your Gmail inbox?',
      mark_read: 'Mark this as read in Gmail?',
      mark_unread: 'Mark this as unread in Gmail?',
      star: 'Star this in Gmail?',
      unstar: 'Remove the star in Gmail?',
      trash: 'Move this to the Gmail trash?',
      untrash: 'Take this out of the Gmail trash?',
      add_labels: 'Add these Gmail labels?',
      remove_labels: 'Remove these Gmail labels?'
    },
    approve: 'Approve',
    decline: 'Decline',
    approving: 'Approving…',
    declining: 'Declining…',
    labels: {
      ...en.labels,
      quote: 'Quoted message',
      truncated: 'The quoted message is shortened.',
      name: 'Name',
      labels: 'Labels',
      appliesTo: 'Applies to',
      conversation: 'The whole conversation',
      oneEmail: 'One email'
    },
    approved: 'Approved. Your assistant will carry it out.',
    declined: 'Declined. Your assistant won’t do this.',
    superseded: 'A newer request replaced this one.',
    closed: 'This request is no longer waiting for you.',
    changed: 'This draft doesn’t match what your assistant proposed, so it can’t be approved here. Ask for a fresh one.',
    retry: 'Couldn’t reach Atum. Try again.',
    work: {
      source: 'From Work on this Mac',
      approved: 'Approved.',
      declined: 'Declined. Nothing was changed.',
      superseded: 'A newer request from Work replaced this one.',
      expired: 'This request expired.',
      changed: 'This doesn’t match what Work asked for, so it can’t be approved here.'
    }
  },
  vi: {
    question: {
      send_email: vi.message['send-email'],
      create_event: vi.message['create-event'],
      update_event: vi.message['update-event'],
      create_draft: 'Lưu thư nháp này trong Gmail?',
      update_draft: 'Cập nhật thư nháp Gmail này?',
      create_label: 'Tạo nhãn Gmail này?'
    },
    mailbox: {
      archive: 'Lưu trữ mục này trong Gmail?',
      unarchive: 'Đưa mục này về hộp thư đến Gmail?',
      mark_read: 'Đánh dấu đã đọc trong Gmail?',
      mark_unread: 'Đánh dấu chưa đọc trong Gmail?',
      star: 'Gắn sao trong Gmail?',
      unstar: 'Bỏ gắn sao trong Gmail?',
      trash: 'Chuyển mục này vào thùng rác Gmail?',
      untrash: 'Lấy mục này ra khỏi thùng rác Gmail?',
      add_labels: 'Thêm các nhãn Gmail này?',
      remove_labels: 'Gỡ các nhãn Gmail này?'
    },
    approve: 'Duyệt',
    decline: 'Từ chối',
    approving: 'Đang duyệt…',
    declining: 'Đang từ chối…',
    labels: {
      ...vi.labels,
      quote: 'Tin nhắn được trích dẫn',
      truncated: 'Tin nhắn trích dẫn đã được rút gọn.',
      name: 'Tên',
      labels: 'Nhãn',
      appliesTo: 'Áp dụng cho',
      conversation: 'Cả cuộc trò chuyện',
      oneEmail: 'Một email'
    },
    approved: 'Đã duyệt. Trợ lý sẽ thực hiện việc này.',
    declined: 'Đã từ chối. Trợ lý sẽ không thực hiện việc này.',
    superseded: 'Một yêu cầu mới hơn đã thay thế yêu cầu này.',
    closed: 'Yêu cầu này không còn chờ bạn nữa.',
    changed: 'Bản nháp này không khớp với đề xuất của trợ lý nên không thể duyệt ở đây. Hãy nhờ soạn lại.',
    retry: 'Không kết nối được với Atum. Hãy thử lại.',
    work: {
      source: 'Từ Work trên máy Mac này',
      approved: 'Đã duyệt.',
      declined: 'Đã từ chối. Không có gì thay đổi.',
      superseded: 'Một yêu cầu mới hơn từ Work đã thay thế yêu cầu này.',
      expired: 'Yêu cầu này đã hết hạn.',
      changed: 'Nội dung này không khớp với yêu cầu của Work nên không thể duyệt ở đây.'
    }
  }
}

export function matrixGoogleWriteCardCopy(locale: Locale): MatrixGoogleWriteCardCopy {
  return copies[locale] ?? copies.en!
}
