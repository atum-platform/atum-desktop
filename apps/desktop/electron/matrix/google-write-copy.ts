import type { UtilityWriteLabels } from '../atum-utilities'

type Action = 'send-email' | 'create-event' | 'update-event'

export interface MatrixGoogleWriteCopy {
  /** The dialog's question, per action. */
  message: Record<Action, string>
  /** The confirming button, per action; Cancel is the default. */
  confirm: Record<Action, string>
  cancel: string
  labels: UtilityWriteLabels
}

/**
 * The owner's confirmation of the exact email or event the assistant wants to send or save
 * (G2-08). Five locales together; Vietnamese is the default. The values shown under these
 * labels are the exact content, never a summary.
 */
export const MATRIX_GOOGLE_WRITE_COPY: Record<'en' | 'vi' | 'ja' | 'zh' | 'zh-hant', MatrixGoogleWriteCopy> = {
  en: {
    message: {
      'send-email': 'Send this email?',
      'create-event': 'Add this event to your calendar?',
      'update-event': 'Save these changes to your calendar?'
    },
    confirm: { 'send-email': 'Send', 'create-event': 'Add event', 'update-event': 'Save changes' },
    cancel: 'Cancel',
    labels: {
      from: 'From', to: 'To', cc: 'Cc', bcc: 'Bcc', attachments: 'Attachments', forwarded: 'Forwarded message',
      subject: 'Subject', inReplyTo: 'Replies in the same conversation.',
      calendar: 'Calendar', title: 'Title', start: 'Start', end: 'End', location: 'Location', notes: 'Notes',
      current: 'Now:', after: 'After:', noInvitations: 'Only your own event changes. No invitations are sent.'
    }
  },
  vi: {
    message: {
      'send-email': 'Gửi email này?',
      'create-event': 'Thêm sự kiện này vào lịch?',
      'update-event': 'Lưu thay đổi này vào lịch?'
    },
    confirm: { 'send-email': 'Gửi', 'create-event': 'Thêm sự kiện', 'update-event': 'Lưu thay đổi' },
    cancel: 'Hủy',
    labels: {
      from: 'Từ', to: 'Đến', cc: 'Cc', bcc: 'Bcc', attachments: 'Tệp đính kèm', forwarded: 'Thư được chuyển tiếp',
      subject: 'Tiêu đề', inReplyTo: 'Trả lời trong cùng cuộc trò chuyện.',
      calendar: 'Lịch', title: 'Tên', start: 'Bắt đầu', end: 'Kết thúc', location: 'Địa điểm', notes: 'Ghi chú',
      current: 'Hiện tại:', after: 'Sau khi đổi:', noInvitations: 'Chỉ đổi sự kiện của riêng bạn. Không gửi lời mời nào.'
    }
  },
  ja: {
    message: {
      'send-email': 'このメールを送信しますか？',
      'create-event': 'この予定をカレンダーに追加しますか？',
      'update-event': 'この変更をカレンダーに保存しますか？'
    },
    confirm: { 'send-email': '送信', 'create-event': '予定を追加', 'update-event': '変更を保存' },
    cancel: 'キャンセル',
    labels: {
      from: '差出人', to: '宛先', cc: 'Cc', bcc: 'Bcc', attachments: '添付ファイル', forwarded: '転送するメッセージ',
      subject: '件名', inReplyTo: '同じスレッドに返信します。',
      calendar: 'カレンダー', title: 'タイトル', start: '開始', end: '終了', location: '場所', notes: 'メモ',
      current: '現在：', after: '変更後：', noInvitations: 'あなた自身の予定だけを変更します。招待は送信されません。'
    }
  },
  zh: {
    message: {
      'send-email': '发送这封邮件？',
      'create-event': '将此活动添加到日历？',
      'update-event': '将这些更改保存到日历？'
    },
    confirm: { 'send-email': '发送', 'create-event': '添加活动', 'update-event': '保存更改' },
    cancel: '取消',
    labels: {
      from: '发件人', to: '收件人', cc: '抄送', bcc: '密送', attachments: '附件', forwarded: '转发的邮件',
      subject: '主题', inReplyTo: '在同一会话中回复。',
      calendar: '日历', title: '标题', start: '开始', end: '结束', location: '地点', notes: '备注',
      current: '当前：', after: '更改后：', noInvitations: '只更改你自己的活动，不会发送邀请。'
    }
  },
  'zh-hant': {
    message: {
      'send-email': '傳送這封郵件？',
      'create-event': '將此活動新增到日曆？',
      'update-event': '將這些變更儲存到日曆？'
    },
    confirm: { 'send-email': '傳送', 'create-event': '新增活動', 'update-event': '儲存變更' },
    cancel: '取消',
    labels: {
      from: '寄件者', to: '收件者', cc: '副本', bcc: '密件副本', attachments: '附件', forwarded: '轉寄的郵件',
      subject: '主旨', inReplyTo: '在同一對話中回覆。',
      calendar: '日曆', title: '標題', start: '開始', end: '結束', location: '地點', notes: '備註',
      current: '目前：', after: '變更後：', noInvitations: '只變更你自己的活動，不會傳送邀請。'
    }
  }
}

/** The person's display language, else Vietnamese (Atum's default). */
export function matrixGoogleWriteCopy(locale: unknown): MatrixGoogleWriteCopy {
  return typeof locale === 'string' && Object.hasOwn(MATRIX_GOOGLE_WRITE_COPY, locale)
    ? MATRIX_GOOGLE_WRITE_COPY[locale as keyof typeof MATRIX_GOOGLE_WRITE_COPY]
    : MATRIX_GOOGLE_WRITE_COPY.vi
}
