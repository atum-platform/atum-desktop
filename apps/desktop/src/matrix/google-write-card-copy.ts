import type { Locale } from '@/i18n'

import { MATRIX_GOOGLE_WRITE_COPY, type MatrixGoogleWriteLabels } from '../../shared/matrix-google-write-copy'
import type { MatrixGoogleWriteKind } from '../../shared/matrix-google-write-proposal'

/**
 * The Google write card's words (docs/google-write-confirmation.md). The question and the field
 * names are the same table the main-process write dialog speaks (`shared/matrix-google-write-copy.ts`);
 * the card adds only its own actions and states. English and Vietnamese; any other language falls
 * back to English, as the app's copy does.
 *
 * Approve never sends anything itself (the assistant carries the approved request out), so no
 * state here says sent, added or saved.
 */
export interface MatrixGoogleWriteCardCopy {
  question: Record<MatrixGoogleWriteKind, string>
  approve: string
  decline: string
  approving: string
  declining: string
  labels: MatrixGoogleWriteLabels & { quote: string; truncated: string }
  /** One calm line per state a card can settle in. */
  approved: string
  declined: string
  superseded: string
  closed: string
  changed: string
  /** Under the actions when Atum could not be reached; the actions stay. */
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
    labels: table.labels
  }
}

const en = from('en')
const vi = from('vi')

const copies: Partial<Record<Locale, MatrixGoogleWriteCardCopy>> = {
  en: {
    question: en.question,
    approve: 'Approve',
    decline: 'Decline',
    approving: 'Approving…',
    declining: 'Declining…',
    labels: { ...en.labels, quote: 'Quoted message', truncated: 'The quoted message is shortened.' },
    approved: 'Approved. Your assistant will carry it out.',
    declined: 'Declined. Your assistant won’t do this.',
    superseded: 'A newer request replaced this one.',
    closed: 'This request is no longer waiting for you.',
    changed: 'This draft doesn’t match what your assistant proposed, so it can’t be approved here. Ask for a fresh one.',
    retry: 'Couldn’t reach Atum. Try again.'
  },
  vi: {
    question: vi.question,
    approve: 'Duyệt',
    decline: 'Từ chối',
    approving: 'Đang duyệt…',
    declining: 'Đang từ chối…',
    labels: { ...vi.labels, quote: 'Tin nhắn được trích dẫn', truncated: 'Tin nhắn trích dẫn đã được rút gọn.' },
    approved: 'Đã duyệt. Trợ lý sẽ thực hiện việc này.',
    declined: 'Đã từ chối. Trợ lý sẽ không thực hiện việc này.',
    superseded: 'Một yêu cầu mới hơn đã thay thế yêu cầu này.',
    closed: 'Yêu cầu này không còn chờ bạn nữa.',
    changed: 'Bản nháp này không khớp với đề xuất của trợ lý nên không thể duyệt ở đây. Hãy nhờ soạn lại.',
    retry: 'Không kết nối được với Atum. Hãy thử lại.'
  }
}

export function matrixGoogleWriteCardCopy(locale: Locale): MatrixGoogleWriteCardCopy {
  return copies[locale] ?? copies.en!
}
