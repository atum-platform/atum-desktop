import type { Locale } from '@/i18n'

export const pagesCopy: Record<
  Locale,
  {
    session: string
    readOnly: string
    loading: string
    empty: string
    failed: string
    jobs: string
    stored: string
    installIncomplete: string
    installObservingEnded: string
    archive: string
    archiving: string
    archiveIncomplete: string
    archiveObservingEnded: string
    updateIncomplete: string
    updateObservingEnded: string
    updateNote: string
  }
> = {
  en: {
    archive: 'Archive',
    archiving: 'Archiving…',
    archiveIncomplete: 'The skill could not be archived. Review its log before retrying.',
    archiveObservingEnded: 'Archiving is still running. Reopen Skills Hub to check installed skills; do not retry yet.',
    updateIncomplete: 'The skill update did not complete. Review its log before retrying.',
    updateObservingEnded: 'Updating is still running. Reopen Skills Hub to check installed skills; do not retry yet.',
    updateNote: 'Updates retain a rollback copy and apply in new conversations.',
    session: 'Session',
    readOnly: 'A read-only record from this Mac.',
    loading: 'Opening this Mac’s management pages…',
    empty: 'No text content',
    failed: 'Could not load this local page. Please try again.',
    jobs: 'Jobs run on this Mac',
    stored: 'Stored on this Mac',
    installIncomplete: 'The skill installation did not complete. Review its log before retrying.',
    installObservingEnded:
      'Installation is still running. Reopen Skills Hub to check installed skills; do not retry yet.'
  },
  vi: {
    archive: 'Lưu trữ',
    archiving: 'Đang lưu trữ…',
    archiveIncomplete: 'Chưa lưu trữ được kỹ năng. Hãy xem nhật ký trước khi thử lại.',
    archiveObservingEnded: 'Quá trình lưu trữ vẫn đang chạy. Mở lại Kho kỹ năng để kiểm tra; chưa nên thử lại.',
    updateIncomplete: 'Chưa cập nhật được kỹ năng. Hãy xem nhật ký trước khi thử lại.',
    updateObservingEnded: 'Quá trình cập nhật vẫn đang chạy. Mở lại Kho kỹ năng để kiểm tra; chưa nên thử lại.',
    updateNote: 'Bản cập nhật giữ lại bản có thể khôi phục và chỉ áp dụng cho cuộc trò chuyện mới.',
    session: 'Phiên làm việc',
    readOnly: 'Bản ghi chỉ đọc trên máy Mac này.',
    loading: 'Đang mở trang quản lý trên máy Mac này…',
    empty: 'Không có nội dung văn bản',
    failed: 'Không thể tải trang cục bộ này. Vui lòng thử lại.',
    jobs: 'Lịch chạy trên máy Mac này',
    stored: 'Lưu trên máy Mac này',
    installIncomplete: 'Chưa cài đặt được kỹ năng. Hãy xem nhật ký trước khi thử lại.',
    installObservingEnded: 'Quá trình cài đặt vẫn đang chạy. Mở lại Kho kỹ năng để kiểm tra; chưa nên thử lại.'
  },
  ja: {
    archive: 'アーカイブ',
    archiving: 'アーカイブ中…',
    archiveIncomplete: 'スキルをアーカイブできませんでした。再試行する前にログを確認してください。',
    archiveObservingEnded: 'アーカイブはまだ実行中です。スキルハブを開き直して確認し、まだ再試行しないでください。',
    updateIncomplete: 'スキルの更新は完了しませんでした。再試行する前にログを確認してください。',
    updateObservingEnded: '更新はまだ実行中です。スキルハブを開き直して確認し、まだ再試行しないでください。',
    updateNote: '更新前の版は復元用に保持され、変更は新しい会話に適用されます。',
    session: 'セッション',
    readOnly: 'この Mac の読み取り専用の記録です。',
    loading: 'この Mac の管理ページを開いています…',
    empty: 'テキストはありません',
    failed: 'ローカルページを読み込めませんでした。もう一度お試しください。',
    jobs: 'この Mac でジョブを実行',
    stored: 'この Mac に保存',
    installIncomplete: 'スキルのインストールは完了しませんでした。再試行する前にログを確認してください。',
    installObservingEnded: 'インストールはまだ実行中です。スキルハブを開き直して確認し、まだ再試行しないでください。'
  },
  zh: {
    archive: '归档',
    archiving: '正在归档…',
    archiveIncomplete: '无法归档技能。请先查看日志，再决定是否重试。',
    archiveObservingEnded: '归档仍在运行。请重新打开技能中心查看已安装的技能，暂时不要重试。',
    updateIncomplete: '技能更新未完成。请先查看日志，再决定是否重试。',
    updateObservingEnded: '更新仍在运行。请重新打开技能中心查看已安装的技能，暂时不要重试。',
    updateNote: '更新会保留可回滚的副本，并在新对话中生效。',
    session: '会话',
    readOnly: '此 Mac 上的只读记录。',
    loading: '正在打开此 Mac 的管理页面…',
    empty: '没有文本内容',
    failed: '无法加载本地页面，请重试。',
    jobs: '任务在此 Mac 上运行',
    stored: '保存在此 Mac 上',
    installIncomplete: '技能安装未完成。请先查看日志，再决定是否重试。',
    installObservingEnded: '安装仍在运行。请重新打开技能中心查看已安装的技能，暂时不要重试。'
  },
  'zh-hant': {
    archive: '封存',
    archiving: '正在封存…',
    archiveIncomplete: '無法封存技能。請先查看記錄，再決定是否重試。',
    archiveObservingEnded: '封存仍在執行中。請重新開啟技能中心查看已安裝的技能，暫時不要重試。',
    updateIncomplete: '技能更新尚未完成。請先查看記錄，再決定是否重試。',
    updateObservingEnded: '更新仍在執行中。請重新開啟技能中心查看已安裝的技能，暫時不要重試。',
    updateNote: '更新會保留可復原的副本，並套用至新的對話。',
    session: '工作階段',
    readOnly: '此 Mac 上的唯讀記錄。',
    loading: '正在開啟此 Mac 的管理頁面…',
    empty: '沒有文字內容',
    failed: '無法載入本機頁面，請重試。',
    jobs: '工作在此 Mac 上執行',
    stored: '儲存在此 Mac 上',
    installIncomplete: '技能安裝尚未完成。請先查看記錄，再決定是否重試。',
    installObservingEnded: '安裝仍在執行中。請重新開啟技能中心查看已安裝的技能，暫時不要重試。'
  }
}
