import type { MatrixDebugConfirmation } from './matrix-debug-share'
interface Copy {
  title: string
  help: string
  preview: string
  upload: string
  status: string
  report: string
  destination: string
  privacy: string
  pasteRetention: string
  dpasteRetention: string
  unknown: string
  running: string
  succeeded: string
  uncertain: string
  failed: string
  cancelled: string
  loading: string
  open: string
  copy: string
  cancel: string
  allow: string
  confirm: string
  selection: string
  copied: string
}
export const matrixDebugShareCopy: Record<string, Copy> = {
  en: {
    title: 'Debug sharing',
    help: 'Capture a local preview from this agent. The report includes recent log tails; optional full logs are capped at their last 500 KB. Only selected, previewed text is uploaded.',
    preview: 'Capture local preview',
    upload: 'Share selected text…',
    status: 'Check upload status',
    report: 'Report',
    destination: 'Public destination',
    privacy: 'Anyone with the link can read what you share, so check it for personal details first.',
    pasteRetention:
      'paste.rs: deletion is attempted after six hours by a future cleanup run. It is best effort and may never run.',
    dpasteRetention: 'dpaste.com: request seven-day expiry. Atum cannot delete this paste through its API.',
    unknown:
      'No upload receipt in this backend. A restart can lose the receipt; this does not prove that nothing was published.',
    running: 'Upload is running. Closing this view does not cancel it. Check status before sharing again.',
    succeeded: 'Selected uploads returned public links.',
    uncertain:
      'An upload response was lost or invalid. This file may already be public. Remaining files were not sent; no automatic retry or fallback occurs.',
    failed: 'Could not complete this request. If sharing had started, check status before sharing again.',
    cancelled: 'Sharing cancelled. No upload was started.',
    loading: 'Working…',
    open: 'Open link',
    copy: 'Copy link',
    cancel: 'Cancel',
    allow: 'Publish selected text',
    confirm: 'Publish public debug data',
    selection: 'Files and UTF-8 byte counts',
    copied: 'Link copied'
  },
  vi: {
    title: 'Chia sẻ chẩn đoán',
    help: 'Tạo bản xem trước cục bộ từ trợ lý này. Báo cáo có các dòng nhật ký gần đây; nhật ký đầy đủ tùy chọn giới hạn 500 KB cuối. Chỉ văn bản đã chọn và xem trước được tải lên.',
    preview: 'Tạo bản xem trước cục bộ',
    upload: 'Chia sẻ văn bản đã chọn…',
    status: 'Kiểm tra tải lên',
    report: 'Báo cáo',
    destination: 'Dịch vụ công khai',
    privacy: 'Ai có liên kết cũng đọc được nội dung bạn chia sẻ, vì vậy hãy kiểm tra thông tin cá nhân trước.',
    pasteRetention:
      'paste.rs: lần dọn dẹp sau sẽ thử xóa sau sáu giờ. Không bảo đảm lần đó sẽ chạy hoặc xóa thành công.',
    dpasteRetention: 'dpaste.com: yêu cầu hết hạn sau bảy ngày. Atum không thể xóa qua API.',
    unknown:
      'Máy chủ này không có biên nhận. Khởi động lại có thể mất biên nhận; điều này không chứng minh dữ liệu chưa được công bố.',
    running: 'Đang tải lên. Đóng cửa sổ không hủy tác vụ. Kiểm tra trạng thái trước khi chia sẻ lại.',
    succeeded: 'Các tệp đã chọn đã trả về liên kết công khai.',
    uncertain:
      'Phản hồi bị mất hoặc không hợp lệ. Tệp này có thể đã công khai. Chưa gửi các tệp còn lại; không tự thử lại hoặc đổi dịch vụ.',
    failed: 'Không hoàn tất yêu cầu. Nếu đã bắt đầu chia sẻ, hãy kiểm tra trạng thái trước khi chia sẻ lại.',
    cancelled: 'Đã hủy. Chưa bắt đầu tải lên.',
    loading: 'Đang xử lý…',
    open: 'Mở liên kết',
    copy: 'Sao chép liên kết',
    cancel: 'Hủy',
    allow: 'Công bố văn bản đã chọn',
    confirm: 'Công bố dữ liệu chẩn đoán',
    selection: 'Tệp và số byte UTF-8',
    copied: 'Đã sao chép'
  },
  zh: {
    title: '共享诊断',
    help: '从此助手创建本地预览。报告包含最近日志；可选完整日志仅包含最后 500 KB。只上传已选择并预览的文本。',
    preview: '创建本地预览',
    upload: '共享所选文本…',
    status: '检查上传状态',
    report: '报告',
    destination: '公开服务',
    privacy: '任何拿到链接的人都能看到你分享的内容，请先检查其中是否有个人信息。',
    pasteRetention: 'paste.rs：未来的清理任务会尝试在六小时后删除。不保证任务执行或删除成功。',
    dpasteRetention: 'dpaste.com：请求七天后过期。Atum 无法通过其 API 删除。',
    unknown: '此后端没有上传回执。重启可能丢失回执；这不代表未曾公开数据。',
    running: '正在上传。关闭视图不会取消。再次共享前请检查状态。',
    succeeded: '所选上传已返回公开链接。',
    uncertain: '上传响应丢失或无效。此文件可能已公开。未发送剩余文件，也不会自动重试或切换服务。',
    failed: '无法完成请求。如已开始共享，请先检查状态再重试。',
    cancelled: '已取消，未开始上传。',
    loading: '处理中…',
    open: '打开链接',
    copy: '复制链接',
    cancel: '取消',
    allow: '公开所选文本',
    confirm: '公开诊断数据',
    selection: '文件及 UTF-8 字节数',
    copied: '已复制链接'
  },
  ja: {
    title: '診断情報の共有',
    help: 'このアシスタントのローカルプレビューを作成します。レポートには最近のログを含み、任意の全ログは末尾 500 KB までです。選択してプレビューしたテキストのみを送信します。',
    preview: 'ローカルプレビューを作成',
    upload: '選択したテキストを共有…',
    status: 'アップロード状況を確認',
    report: 'レポート',
    destination: '公開サービス',
    privacy: 'リンクを知っている人は誰でも共有内容を読めます。先に個人情報が含まれていないか確認してください。',
    pasteRetention: 'paste.rs：将来のクリーンアップで六時間後の削除を試みます。実行や削除は保証されません。',
    dpasteRetention: 'dpaste.com：七日後の期限切れを要求します。Atum は API で削除できません。',
    unknown: 'このバックエンドに送信記録がありません。再起動で記録が失われても、非公開の証明にはなりません。',
    running: '送信中です。閉じても中止されません。再共有前に状況を確認してください。',
    succeeded: '選択した送信の公開リンクが返されました。',
    uncertain:
      '送信応答が失われたか無効でした。このファイルは公開済みかもしれません。残りは送信せず、自動再試行や別サービスへの切替は行いません。',
    failed: 'リクエストを完了できません。共有を開始した場合は再共有前に状況を確認してください。',
    cancelled: '共有を取り消しました。送信は開始されていません。',
    loading: '処理中…',
    open: 'リンクを開く',
    copy: 'リンクをコピー',
    cancel: 'キャンセル',
    allow: '選択したテキストを公開',
    confirm: '診断情報を公開',
    selection: 'ファイルと UTF-8 バイト数',
    copied: 'コピーしました'
  },
  'zh-hant': {
    title: '分享診斷',
    help: '從此智慧代理建立本機預覽。報告包含最近記錄；可選完整記錄僅包含最後 500 KB。只上傳已選擇並預覽的文字。',
    preview: '建立本機預覽',
    upload: '分享所選文字…',
    status: '檢查上傳狀態',
    report: '報告',
    destination: '公開服務',
    privacy: '任何拿到連結的人都能看到你分享的內容，請先檢查其中是否有個人資訊。',
    pasteRetention: 'paste.rs：未來的清理工作會嘗試在六小時後刪除。不保證工作執行或刪除成功。',
    dpasteRetention: 'dpaste.com：要求七天後到期。Atum 無法透過其 API 刪除。',
    unknown: '此後端沒有上傳收據。重新啟動可能遺失收據；這不代表未曾公開資料。',
    running: '正在上傳。關閉檢視不會取消。再次分享前請檢查狀態。',
    succeeded: '所選上傳已傳回公開連結。',
    uncertain: '上傳回應遺失或無效。此檔案可能已公開。未傳送剩餘檔案，也不會自動重試或切換服務。',
    failed: '無法完成要求。如已開始分享，請先檢查狀態再重試。',
    cancelled: '已取消，未開始上傳。',
    loading: '處理中…',
    open: '開啟連結',
    copy: '複製連結',
    cancel: '取消',
    allow: '公開所選文字',
    confirm: '公開診斷資料',
    selection: '檔案及 UTF-8 位元組數',
    copied: '已複製連結'
  }
}

export function matrixDebugConfirmationCopy(locale: string, agentName: string, value: MatrixDebugConfirmation) {
  const c = matrixDebugShareCopy[locale] ?? matrixDebugShareCopy.en

  return {
    title: c.confirm,
    cancel: c.cancel,
    allow: c.allow,
    detail: `${agentName}\n${c.destination}: https://${value.destination}/\n\n${c.selection}:\n${value.files.map(f => `${f.label}: ${f.bytes}`).join('\n')}\n\n${c.privacy}\n\n${value.destination === 'paste.rs' ? c.pasteRetention : c.dpasteRetention}`
  }
}
