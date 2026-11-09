import type { MatrixCuratorAction } from './matrix-curator'

interface Copy {
  title: string
  pause: string
  resume: string
  run: string
  refresh: string
  cancel: string
  allow: string
  paused: string
  active: string
  disabled: string
  unknown: string
  running: string
  succeeded: string
  failed: string
  cancelled: string
  unavailable: string
  warning: string
  pauseDetail: string
  resumeDetail: string
  interval: string
  lastRun: string
  never: string
}
export const matrixCuratorCopy: Record<string, Copy> = {
  en: {
    title: 'Skill maintenance',
    pause: 'Pause curator',
    resume: 'Resume curator',
    run: 'Run curator now…',
    refresh: 'Check curator status',
    cancel: 'Cancel',
    allow: 'Allow',
    paused: 'Automatic maintenance is paused.',
    active: 'Automatic maintenance is active.',
    disabled: 'Automatic maintenance is disabled in configuration.',
    unknown: 'No run receipt is available. After a restart, this does not prove no changes were made.',
    running: 'Curator is running. Closing this page leaves the confirmed run active.',
    succeeded: 'The curator command completed.',
    failed:
      'The curator command did not complete successfully. Skills may have changed; check status before starting another run.',
    cancelled: 'Cancelled. No change was started.',
    unavailable: 'Curator status or the result is unavailable. Check status before trying again.',
    warning: 'Maintenance may archive some of this agent’s skills and can cost extra with your model provider.',
    pauseDetail: 'Pause future automatic skill maintenance for this agent. A run already in progress continues.',
    resumeDetail:
      'Resume automatic skill maintenance for this agent, subject to its configuration. It may archive skills and use the auxiliary model when consolidation is enabled.',
    interval: 'Interval (hours)',
    lastRun: 'Last run',
    never: 'Never recorded'
  },
  vi: {
    title: 'Bảo trì kỹ năng',
    pause: 'Tạm dừng curator',
    resume: 'Tiếp tục curator',
    run: 'Chạy curator ngay…',
    refresh: 'Kiểm tra trạng thái curator',
    cancel: 'Hủy',
    allow: 'Cho phép',
    paused: 'Bảo trì tự động đang tạm dừng.',
    active: 'Bảo trì tự động đang hoạt động.',
    disabled: 'Bảo trì tự động đã bị tắt trong cấu hình.',
    unknown: 'Không có biên nhận lần chạy. Sau khi khởi động lại, điều này không chứng minh chưa có thay đổi.',
    running: 'Curator đang chạy. Đóng trang này không dừng lần chạy đã xác nhận.',
    succeeded: 'Lệnh curator đã hoàn tất.',
    failed:
      'Lệnh curator chưa hoàn tất thành công. Kỹ năng có thể đã thay đổi; hãy kiểm tra trạng thái trước khi chạy lại.',
    cancelled: 'Đã hủy. Chưa bắt đầu thay đổi.',
    unavailable: 'Không đọc được trạng thái hoặc kết quả. Hãy kiểm tra trạng thái trước khi thử lại.',
    warning: 'Bảo trì có thể lưu trữ một số kỹ năng của trợ lý này và có thể phát sinh thêm phí với nhà cung cấp mô hình.',
    pauseDetail:
      'Tạm dừng các lần bảo trì kỹ năng tự động tiếp theo của trợ lý này. Lần chạy đang diễn ra vẫn tiếp tục.',
    resumeDetail:
      'Tiếp tục bảo trì kỹ năng tự động cho trợ lý này theo cấu hình. Có thể lưu trữ kỹ năng và dùng mô hình phụ nếu bật hợp nhất.',
    interval: 'Chu kỳ (giờ)',
    lastRun: 'Lần chạy gần nhất',
    never: 'Chưa ghi nhận'
  },
  zh: {
    title: '技能维护',
    pause: '暂停维护',
    resume: '恢复维护',
    run: '立即运行维护…',
    refresh: '检查维护状态',
    cancel: '取消',
    allow: '允许',
    paused: '自动维护已暂停。',
    active: '自动维护已启用。',
    disabled: '配置中已禁用自动维护。',
    unknown: '没有运行记录。重启后，这不代表未发生任何更改。',
    running: '维护正在运行。关闭此页面不会停止已确认的运行。',
    succeeded: '维护命令已完成。',
    failed: '维护命令未成功完成。技能可能已更改；再次运行前请检查状态。',
    cancelled: '已取消。未开始更改。',
    unavailable: '无法读取维护状态或结果。重试前请检查状态。',
    warning: '维护可能会归档此助理的部分技能，并可能产生模型服务商的额外费用。',
    pauseDetail: '暂停此助理今后的自动技能维护。正在运行的任务将继续。',
    resumeDetail: '按配置恢复此助理的自动技能维护。可能归档技能；启用合并时可能使用辅助模型。',
    interval: '间隔（小时）',
    lastRun: '上次运行',
    never: '无记录'
  },
  'zh-hant': {
    title: '技能維護',
    pause: '暫停維護',
    resume: '恢復維護',
    run: '立即執行維護…',
    refresh: '檢查維護狀態',
    cancel: '取消',
    allow: '允許',
    paused: '自動維護已暫停。',
    active: '自動維護已啟用。',
    disabled: '設定中已停用自動維護。',
    unknown: '沒有執行記錄。重新啟動後，這不代表未發生任何變更。',
    running: '維護正在執行。關閉此頁面不會停止已確認的執行。',
    succeeded: '維護命令已完成。',
    failed: '維護命令未成功完成。技能可能已變更；再次執行前請檢查狀態。',
    cancelled: '已取消。未開始變更。',
    unavailable: '無法讀取維護狀態或結果。重試前請檢查狀態。',
    warning: '維護可能會封存此助理的部分技能，並可能產生模型供應商的額外費用。',
    pauseDetail: '暫停此助理今後的自動技能維護。正在執行的工作將繼續。',
    resumeDetail: '依設定恢復此助理的自動技能維護。可能封存技能；啟用合併時可能使用輔助模型。',
    interval: '間隔（小時）',
    lastRun: '上次執行',
    never: '無記錄'
  },
  ja: {
    title: 'スキルのメンテナンス',
    pause: '自動保守を一時停止',
    resume: '自動保守を再開',
    run: '今すぐ保守を実行…',
    refresh: '保守の状態を確認',
    cancel: 'キャンセル',
    allow: '許可',
    paused: '自動保守は一時停止中です。',
    active: '自動保守は有効です。',
    disabled: '設定で自動保守が無効になっています。',
    unknown: '実行記録はありません。再起動後は、変更がなかったことの証明にはなりません。',
    running: '保守を実行中です。このページを閉じても確認済みの実行は続きます。',
    succeeded: '保守コマンドが完了しました。',
    failed:
      '保守コマンドは正常に完了しませんでした。スキルが変更された可能性があります。再実行前に状態を確認してください。',
    cancelled: 'キャンセルしました。変更は開始していません。',
    unavailable: '保守の状態または結果を取得できません。再試行前に状態を確認してください。',
    warning: 'メンテナンスでは、このアシスタントのスキルの一部がアーカイブされることがあり、モデル提供元の追加料金がかかる場合があります。',
    pauseDetail: 'このアシスタントの今後の自動保守を一時停止します。実行中の処理は続きます。',
    resumeDetail:
      '設定に従ってこのアシスタントの自動保守を再開します。スキルのアーカイブや、統合が有効な場合の補助モデル利用が発生する可能性があります。',
    interval: '間隔（時間）',
    lastRun: '前回の実行',
    never: '記録なし'
  }
}

export function matrixCuratorConfirmation(locale: string, agentName: string, action: MatrixCuratorAction) {
  const c = matrixCuratorCopy[locale] ?? matrixCuratorCopy.en

  return {
    title: `${c[action]} · ${agentName}`,
    detail: action === 'run' ? c.warning : c[`${action}Detail`],
    cancel: c.cancel,
    allow: c.allow
  }
}
