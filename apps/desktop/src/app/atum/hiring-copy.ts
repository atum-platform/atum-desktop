// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
const en = {
  retired: 'This offering is no longer available to renew. Your employee’s history, files and training are saved.',
  intro: 'Hire an employee by the month. AI usage comes from your account’s Proton balance.',
  empty: 'No employees are available to hire yet.', mine: 'Your hired employees', hire: 'Hire', rehire: 'Rehire',
  resume: 'Keep renewing', cancel: 'Stop renewal', open: 'Open', name: 'Employee name', month: 'month',
  consent: 'I agree to pay this fee now and automatically each month from my Proton balance. AI usage is charged separately. I can stop renewal at any time.',
  consentResume: 'I agree to automatic monthly renewal from my Proton balance. No additional hiring fee is charged during the current paid period. AI usage is charged separately.',
  pending: 'Your checkout needs finishing. Continue with the same employee and payment.',
  continue: 'Continue checkout', unavailable: 'We couldn’t check hiring. Please try again.',
  failed: 'Hiring could not be completed. Your checkout is saved; retry to check it safely.',
  insufficient: 'There aren’t enough Protons. Add Protons to your account, then continue checkout.',
  changed: 'The price changed. Review the new monthly fee before continuing.',
  paused: 'Paused', renews: 'Renews', ends: 'Available until', cancelNote: 'Renewal stopped. History, files and training stay with this employee.',
  storage: 'Checkout could not be saved on this computer. Please restart Atum and try again.',
  separate: 'AI usage is paid separately.', confirming: 'Finishing checkout…', working: 'Working…'
}

export type HiringCopy = typeof en

const vi: HiringCopy = {
  retired: 'Gói thuê này không còn khả dụng để gia hạn. Lịch sử, tệp và kỹ năng của trợ lý vẫn được lưu.',
  intro: 'Thuê trợ lý theo tháng. Chi phí AI được trừ từ số dư Proton trong tài khoản của bạn.',
  empty: 'Chưa có trợ lý nào để thuê.', mine: 'Trợ lý đã thuê', hire: 'Thuê', rehire: 'Thuê lại',
  resume: 'Tiếp tục gia hạn', cancel: 'Dừng gia hạn', open: 'Mở', name: 'Tên trợ lý', month: 'tháng',
  consent: 'Tôi đồng ý trả phí này ngay và tự động mỗi tháng từ số dư Proton. Chi phí AI được tính riêng. Tôi có thể dừng gia hạn bất cứ lúc nào.',
  consentResume: 'Tôi đồng ý tự động gia hạn hàng tháng từ số dư Proton. Không thu thêm phí thuê trong thời gian đã thanh toán. Chi phí AI được tính riêng.',
  pending: 'Cần hoàn tất lần thuê này. Tiếp tục với cùng trợ lý và khoản thanh toán.',
  continue: 'Tiếp tục thanh toán', unavailable: 'Chưa kiểm tra được trạng thái thuê. Vui lòng thử lại.',
  failed: 'Chưa hoàn tất thuê trợ lý. Yêu cầu đã được lưu; thử lại để kiểm tra an toàn.',
  insufficient: 'Chưa đủ Proton. Nạp thêm Proton vào tài khoản rồi tiếp tục thanh toán.',
  changed: 'Giá đã thay đổi. Xem lại phí hàng tháng trước khi tiếp tục.',
  paused: 'Tạm dừng', renews: 'Gia hạn', ends: 'Sử dụng đến', cancelNote: 'Đã dừng gia hạn. Lịch sử, tệp và kỹ năng vẫn thuộc trợ lý này.',
  storage: 'Không lưu được yêu cầu thuê trên máy này. Vui lòng khởi động lại Atum và thử lại.',
  separate: 'Chi phí AI được tính riêng.', confirming: 'Đang hoàn tất thanh toán…', working: 'Đang xử lý…'
}

const zh: HiringCopy = {
  retired: '此服务已无法续订。员工的历史记录、文件和技能都会保留。',
  intro: '按月雇用员工。AI 使用费用从您的账户 Proton 余额中扣除。', empty: '暂无可雇用的员工。', mine: '已雇用的员工', hire: '雇用', rehire: '重新雇用',
  resume: '继续续订', cancel: '停止续订', open: '打开', name: '员工姓名', month: '月',
  consent: '我同意现在及之后每月自动从 Proton 余额支付此费用。AI 使用另行收费。我可以随时停止续订。',
  consentResume: '我同意每月自动从 Proton 余额续订。当前已付费期间不会额外收取雇用费。AI 使用另行收费。',
  pending: '请完成此次雇用。继续使用同一员工和付款请求。', continue: '继续付款', unavailable: '无法查询雇用状态，请重试。',
  failed: '雇用尚未完成。付款请求已保存，请重试以安全查询。', insufficient: 'Proton 不足。请充值后继续付款。', changed: '价格已变更，请确认新的月费。',
  paused: '已暂停', renews: '续订日期', ends: '可用至', cancelNote: '已停止续订。此员工的历史记录、文件和技能都会保留。',
  storage: '无法保存付款请求。请重启 Atum 后重试。', separate: 'AI 使用另行收费。', confirming: '正在完成付款…', working: '处理中…'
}

const zhHant: HiringCopy = {
  retired: '此服務已無法續訂。員工的歷史記錄、檔案和技能都會保留。',
  intro: '按月僱用員工。AI 使用費用從您的帳戶 Proton 餘額中扣除。', empty: '暫無可僱用的員工。', mine: '已僱用的員工', hire: '僱用', rehire: '重新僱用',
  resume: '繼續續訂', cancel: '停止續訂', open: '開啟', name: '員工姓名', month: '月',
  consent: '我同意現在及之後每月自動從 Proton 餘額支付此費用。AI 使用另行收費。我可以隨時停止續訂。',
  consentResume: '我同意每月自動從 Proton 餘額續訂。目前已付費期間不會額外收取僱用費。AI 使用另行收費。',
  pending: '請完成此次僱用。繼續使用同一員工及付款請求。', continue: '繼續付款', unavailable: '無法查詢僱用狀態，請重試。',
  failed: '僱用尚未完成。付款請求已儲存，請重試以安全查詢。', insufficient: 'Proton 不足。請儲值後繼續付款。', changed: '價格已變更，請確認新的月費。',
  paused: '已暫停', renews: '續訂日期', ends: '可用至', cancelNote: '已停止續訂。此員工的歷史記錄、檔案和技能都會保留。',
  storage: '無法儲存付款請求。請重新啟動 Atum 後重試。', separate: 'AI 使用另行收費。', confirming: '正在完成付款…', working: '處理中…'
}

const ja: HiringCopy = {
  retired: 'このサービスは更新できなくなりました。従業員の履歴、ファイル、スキルは保持されます。',
  intro: '従業員を月単位で雇えます。AI の利用料金はアカウントの Proton 残高から支払われます。', empty: '雇用できる従業員はまだいません。', mine: '雇用中の従業員', hire: '雇用', rehire: '再雇用',
  resume: '更新を続ける', cancel: '自動更新を停止', open: '開く', name: '従業員の名前', month: '月',
  consent: 'この料金を今すぐ、以降は毎月自動で Proton 残高から支払うことに同意します。AI 利用は別料金です。自動更新はいつでも停止できます。',
  consentResume: 'Proton 残高からの毎月の自動更新に同意します。支払い済みの期間中に雇用料が追加請求されることはありません。AI 利用は別料金です。',
  pending: '手続きを完了してください。同じ従業員と支払いリクエストで続けます。', continue: '支払いを続ける', unavailable: '雇用状況を確認できませんでした。もう一度お試しください。',
  failed: '雇用を完了できませんでした。リクエストは保存されています。再試行して確認してください。', insufficient: 'Proton が不足しています。チャージしてから支払いを続けてください。', changed: '料金が変更されました。新しい月額料金をご確認ください。',
  paused: '一時停止中', renews: '更新日', ends: '利用期限', cancelNote: '自動更新を停止しました。履歴、ファイル、習得したスキルは保持されます。',
  storage: '支払いリクエストを保存できません。Atum を再起動してお試しください。', separate: 'AI 利用は別料金です。', confirming: '支払いを完了中…', working: '処理中…'
}

export function hiringCopy(locale: string): HiringCopy {
  return ({ en, vi, zh, 'zh-Hant': zhHant, 'zh-hant': zhHant, ja } as Record<string, HiringCopy>)[locale] ?? en
}

export function hiringError(error: unknown, copy: HiringCopy): string {
  const code = error instanceof Error ? error.message : ''

  if (code.includes('insufficient_protons')) { return copy.insufficient }

  if (code.includes('offer_changed')) { return copy.changed }

  if (code.includes('hiring_storage_unavailable')) { return copy.storage }

  return copy.failed
}
