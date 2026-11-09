import type { MatrixLocalAction } from './matrix-command-center-ops'
interface MaintenanceCopy {
  title: string
  doctor: string
  backup: string
  doctorHelp: string
  backupHelp: string
  run: string
  refresh: string
  reveal: string
  loading: string
  cancelled: string
  failed: string
  timeout: string
  truncated: string
  cancel: string
  allow: string
  confirm: string
  states: Record<'unknown' | 'running' | 'succeeded' | 'failed', string>
}
export const matrixMaintenanceCopy: Record<'en' | 'vi' | 'ja' | 'zh' | 'zh-hant', MaintenanceCopy> = {
  en: {
    title: 'Local maintenance',
    doctor: 'Doctor',
    backup: 'Backup',
    doctorHelp:
      'Check this agent’s setup. May check configured services and network connectivity. Does not apply automatic fixes.',
    backupHelp:
      'Save only this agent’s profile on this Mac, including conversations and credentials. Other profiles and external provider storage are excluded. The archive stays local; nothing is uploaded.',
    run: 'Run',
    refresh: 'Check status',
    reveal: 'Show backup in Finder',
    loading: 'Checking…',
    cancelled: 'Cancelled.',
    failed: 'Could not verify this operation. It may still be running. Check status before trying again.',
    timeout: 'Stopped waiting. The operation may still be running; check status to find out.',
    truncated: 'Some log lines were shortened.',
    cancel: 'Cancel',
    allow: 'Run',
    confirm: 'Run local maintenance?',
    states: {
      unknown: 'No result available in this runtime',
      running: 'Running',
      succeeded: 'Completed',
      failed: 'Finished with errors'
    }
  },
  vi: {
    title: 'Bảo trì cục bộ',
    doctor: 'Kiểm tra',
    backup: 'Sao lưu',
    doctorHelp:
      'Kiểm tra thiết lập của trợ lý này. Có thể kiểm tra dịch vụ đã cấu hình và kết nối mạng. Không tự động sửa lỗi.',
    backupHelp:
      'Chỉ lưu hồ sơ của trợ lý này trên máy Mac, gồm hội thoại và thông tin đăng nhập. Không gồm hồ sơ khác hay dữ liệu bên ngoài của nhà cung cấp. Bản sao lưu ở cục bộ; không tải lên.',
    run: 'Chạy',
    refresh: 'Kiểm tra trạng thái',
    reveal: 'Hiện bản sao lưu trong Finder',
    loading: 'Đang kiểm tra…',
    cancelled: 'Đã hủy.',
    failed: 'Không thể xác minh thao tác. Có thể vẫn đang chạy. Kiểm tra trạng thái trước khi thử lại.',
    timeout: 'Đã ngừng chờ. Thao tác có thể vẫn đang chạy; hãy kiểm tra trạng thái.',
    truncated: 'Một số dòng nhật ký đã được rút gọn.',
    cancel: 'Hủy',
    allow: 'Chạy',
    confirm: 'Chạy bảo trì cục bộ?',
    states: {
      unknown: 'Chưa có kết quả trong phiên môi trường này',
      running: 'Đang chạy',
      succeeded: 'Đã hoàn thành',
      failed: 'Đã kết thúc với lỗi'
    }
  },
  ja: {
    title: 'ローカルメンテナンス',
    doctor: '診断',
    backup: 'バックアップ',
    doctorHelp:
      'このアシスタントの設定を確認します。設定済みサービスやネットワーク接続を確認する場合があります。自動修正は行いません。',
    backupHelp:
      '会話と認証情報を含む、このアシスタントのプロファイルだけをこのMacに保存します。他のプロファイルや外部プロバイダーのストレージは含みません。ローカル保存のみで、アップロードしません。',
    run: '実行',
    refresh: '状態を確認',
    reveal: 'Finderでバックアップを表示',
    loading: '確認中…',
    cancelled: 'キャンセルしました。',
    failed: '操作を確認できませんでした。まだ実行中の可能性があります。再試行前に状態を確認してください。',
    timeout: '待機を終了しました。操作はまだ実行中の可能性があります。状態を確認してください。',
    truncated: '一部のログ行を短縮しました。',
    cancel: 'キャンセル',
    allow: '実行',
    confirm: 'ローカルメンテナンスを実行しますか？',
    states: {
      unknown: 'このランタイムの結果はありません',
      running: '実行中',
      succeeded: '完了',
      failed: 'エラーで終了'
    }
  },
  zh: {
    title: '本地维护',
    doctor: '诊断',
    backup: '备份',
    doctorHelp: '检查此助手的设置。可能检查已配置的服务和网络连接。不会自动修复。',
    backupHelp:
      '仅在此 Mac 上保存此助手的配置目录，包括对话和凭据。不包含其他配置目录或外部服务商存储。备份保留在本地，不会上传。',
    run: '运行',
    refresh: '检查状态',
    reveal: '在 Finder 中显示备份',
    loading: '检查中…',
    cancelled: '已取消。',
    failed: '无法确认此操作。它可能仍在运行。请在重试前检查状态。',
    timeout: '已停止等待。操作可能仍在运行，请检查状态。',
    truncated: '部分日志行已缩短。',
    cancel: '取消',
    allow: '运行',
    confirm: '运行本地维护？',
    states: { unknown: '当前运行环境尚无结果', running: '运行中', succeeded: '已完成', failed: '完成但出现错误' }
  },
  'zh-hant': {
    title: '本機維護',
    doctor: '診斷',
    backup: '備份',
    doctorHelp: '檢查此助理的設定。可能檢查已設定的服務和網路連線。不會自動修復。',
    backupHelp:
      '僅在此 Mac 上儲存此助理的設定目錄，包括對話和憑證。不包含其他設定目錄或外部服務商儲存。備份保留在本機，不會上傳。',
    run: '執行',
    refresh: '檢查狀態',
    reveal: '在 Finder 中顯示備份',
    loading: '檢查中…',
    cancelled: '已取消。',
    failed: '無法確認此操作。它可能仍在執行。請在重試前檢查狀態。',
    timeout: '已停止等待。操作可能仍在執行，請檢查狀態。',
    truncated: '部分日誌行已縮短。',
    cancel: '取消',
    allow: '執行',
    confirm: '執行本機維護？',
    states: { unknown: '目前執行環境尚無結果', running: '執行中', succeeded: '已完成', failed: '完成但出現錯誤' }
  }
}

export function matrixMaintenanceConfirmationCopy(locale: string, agentName: string, action: MatrixLocalAction) {
  const c = matrixMaintenanceCopy[locale as keyof typeof matrixMaintenanceCopy] ?? matrixMaintenanceCopy.en

  return {
    title: c.confirm,
    detail: `${agentName} · ${c[action]}\n\n${action === 'doctor' ? c.doctorHelp : c.backupHelp}`,
    cancel: c.cancel,
    allow: c.allow
  }
}
