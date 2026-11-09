import type { MatrixDecryptionAction, MatrixDecryptionReason } from '../../shared/matrix-decryption-reason'

export interface MatrixDecryptionCopy {
  reasons: Record<MatrixDecryptionReason, string>
  identityChanged(name: string): string
  actions: Record<Exclude<MatrixDecryptionAction, 'none'>, string>
}

const copies: Record<string, MatrixDecryptionCopy> = {
  en: {
    reasons: {
      sender_unverified: 'Sent from a device that isn’t verified, so Atum didn’t read it.',
      this_device_unverified: 'The sender’s device held this back until this Mac is verified.',
      withheld: 'The sender chose not to share this message with this Mac.',
      waiting_for_key: 'Waiting for the key. This usually fixes itself when the sender’s device is online.',
      restore_possible: 'Sent before this Mac joined. Restore your messages to read it.',
      restoring: 'Restoring from your backup…',
      no_backup: 'Sent before this Mac joined, and there is no backup of it.',
      before_joined: 'Sent before you joined this chat.',
      sender_identity_changed: 'The sender has a new identity since you verified them.',
      generic: "Couldn't load this message."
    },
    identityChanged: name => `${name} has a new identity since you verified them.`,
    actions: {
      devices: 'Open Devices',
      verify: 'Verify this Mac',
      review: 'Review identity',
      restore: 'Restore messages'
    }
  },
  vi: {
    reasons: {
      sender_unverified: 'Tin được gửi từ thiết bị chưa xác minh nên Atum không đọc.',
      this_device_unverified: 'Thiết bị của người gửi giữ lại tin này đến khi máy này được xác minh.',
      withheld: 'Người gửi chọn không chia sẻ tin này với máy này.',
      waiting_for_key: 'Đang chờ khóa. Thường sẽ đọc được khi thiết bị của người gửi trực tuyến.',
      restore_possible: 'Tin được gửi trước khi máy này tham gia. Khôi phục tin nhắn để đọc.',
      restoring: 'Đang khôi phục từ bản sao lưu…',
      no_backup: 'Tin được gửi trước khi máy này tham gia và không có bản sao lưu.',
      before_joined: 'Tin được gửi trước khi bạn tham gia cuộc trò chuyện.',
      sender_identity_changed: 'Người gửi có danh tính mới kể từ khi bạn xác minh họ.',
      generic: 'Không tải được tin nhắn này.'
    },
    identityChanged: name => `${name} có danh tính mới kể từ khi bạn xác minh họ.`,
    actions: {
      devices: 'Mở Thiết bị',
      verify: 'Xác minh máy này',
      review: 'Xem lại danh tính',
      restore: 'Khôi phục tin nhắn'
    }
  },
  ja: {
    reasons: {
      sender_unverified: '未確認の端末から送信されたため、Atumはこのメッセージを読みませんでした。',
      this_device_unverified: 'このMacが確認されるまで、送信者の端末がこのメッセージを保留しています。',
      withheld: '送信者はこのMacとメッセージを共有しないことを選びました。',
      waiting_for_key: '鍵を待っています。送信者の端末がオンラインになると、通常は解消されます。',
      restore_possible: 'このMacが参加する前に送信されました。メッセージを復元すると読めます。',
      restoring: 'バックアップから復元しています…',
      no_backup: 'このMacが参加する前に送信され、バックアップがありません。',
      before_joined: 'このチャットに参加する前に送信されました。',
      sender_identity_changed: '確認後に送信者のIDが変わりました。',
      generic: 'このメッセージを読み込めませんでした。'
    },
    identityChanged: name => `確認後に${name}のIDが変わりました。`,
    actions: {
      devices: '端末を開く',
      verify: 'このMacを確認',
      review: 'IDを再確認',
      restore: 'メッセージを復元'
    }
  },
  zh: {
    reasons: {
      sender_unverified: '消息来自未经验证的设备，因此 Atum 没有读取。',
      this_device_unverified: '发送方设备暂不分享此消息，直到这台 Mac 通过验证。',
      withheld: '发送方选择不与这台 Mac 分享此消息。',
      waiting_for_key: '正在等待密钥。发送方设备上线后通常会自行恢复。',
      restore_possible: '消息在这台 Mac 加入前发送。恢复消息后即可读取。',
      restoring: '正在从备份恢复…',
      no_backup: '消息在这台 Mac 加入前发送，且没有备份。',
      before_joined: '消息在你加入此聊天前发送。',
      sender_identity_changed: '发送方的身份在你验证后发生了变化。',
      generic: '无法加载此消息。'
    },
    identityChanged: name => `${name} 的身份在你验证后发生了变化。`,
    actions: {
      devices: '打开设备',
      verify: '验证这台 Mac',
      review: '重新检查身份',
      restore: '恢复消息'
    }
  },
  'zh-hant': {
    reasons: {
      sender_unverified: '訊息來自未經驗證的裝置，因此 Atum 沒有讀取。',
      this_device_unverified: '傳送方裝置暫不分享此訊息，直到這台 Mac 通過驗證。',
      withheld: '傳送方選擇不與這台 Mac 分享此訊息。',
      waiting_for_key: '正在等待金鑰。傳送方裝置上線後通常會自行恢復。',
      restore_possible: '訊息在這台 Mac 加入前傳送。還原訊息後即可讀取。',
      restoring: '正在從備份還原…',
      no_backup: '訊息在這台 Mac 加入前傳送，且沒有備份。',
      before_joined: '訊息在你加入此聊天前傳送。',
      sender_identity_changed: '傳送方的身分在你驗證後發生了變化。',
      generic: '無法載入此訊息。'
    },
    identityChanged: name => `${name} 的身分在你驗證後發生了變化。`,
    actions: {
      devices: '開啟裝置',
      verify: '驗證這台 Mac',
      review: '重新檢查身分',
      restore: '還原訊息'
    }
  }
}

export function matrixDecryptionCopy(locale: string): MatrixDecryptionCopy {
  return copies[locale] ?? copies.en
}
