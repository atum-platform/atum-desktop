import type { MatrixPetOverlaySnapshot } from '../../../shared/matrix-pet-overlay'

interface PetOverlayCopy {
  yourTurn: string
  failed: string
  done: string
  popIn: string
  popOut: string
  close: string
  showReplies: string
  screenShare: string
  preferenceFailed: string
}

/** Reply previews are a local display choice, with an explicit screen-sharing note. */
export const petOverlayCopy: Record<MatrixPetOverlaySnapshot['locale'], PetOverlayCopy> = {
  vi: {
    yourTurn: 'Đến lượt bạn',
    failed: 'Có lỗi xảy ra',
    done: 'Đã xong',
    popIn: 'Về Atum',
    popOut: 'Ra màn hình',
    close: 'Đóng',
    showReplies: 'Hiện câu trả lời trên thú cưng ngoài Atum',
    screenShare: 'Câu trả lời hiển thị sẽ xuất hiện khi chia sẻ màn hình.',
    preferenceFailed: 'Chưa lưu được cài đặt hiển thị. Thử lại.'
  },
  en: {
    yourTurn: 'Your turn',
    failed: 'Something went wrong',
    done: 'Done',
    popIn: 'Back to Atum',
    popOut: 'Pop out',
    close: 'Close',
    showReplies: 'Show replies on the pet outside Atum',
    screenShare: 'Visible replies appear in screen shares.',
    preferenceFailed: 'Display preference could not be saved. Try again.'
  },
  ja: {
    yourTurn: 'あなたの番です',
    failed: '問題が発生しました',
    done: '完了',
    popIn: 'Atumに戻す',
    popOut: '画面に出す',
    close: '閉じる',
    showReplies: 'Atumの外でペットに返信を表示',
    screenShare: '表示された返信は画面共有にも映ります。',
    preferenceFailed: '表示設定を保存できませんでした。もう一度お試しください。'
  },
  zh: {
    yourTurn: '轮到你了',
    failed: '出现了问题',
    done: '已完成',
    popIn: '返回 Atum',
    popOut: '移到桌面',
    close: '关闭',
    showReplies: '在 Atum 外的宠物上显示回复',
    screenShare: '可见回复会出现在屏幕共享中。',
    preferenceFailed: '无法保存显示偏好，请重试。'
  },
  'zh-hant': {
    yourTurn: '輪到你了',
    failed: '發生問題',
    done: '已完成',
    popIn: '返回 Atum',
    popOut: '移到桌面',
    close: '關閉',
    showReplies: '在 Atum 外的寵物上顯示回覆',
    screenShare: '可見回覆會出現在螢幕分享中。',
    preferenceFailed: '無法儲存顯示偏好，請重試。'
  }
}
