import type { Locale } from '@/i18n'

const en = {
  workspaceLocalOnly:
    'After connecting Google, automatic sync and restore of memory, skills, assistant instructions and personal pets pause on this computer to protect Google data. New local changes to that content are not uploaded through account sync. Existing account copies and other computers are unaffected. This continues after disconnection.',
  selectionChanged: 'The calendar list changed. Choose which calendars to use in Settings.',
  reviewCalendars: 'Review calendars',
  noCalendars: 'No calendars are available on this Mac yet.',
  addGoogle: 'Add Google account',
  saving: 'Saving…',
  sourceNote:
    'Atum searches checked sources. New Google calendars start unchecked except your primary calendar. The same calendar connected through Google and this Mac may appear twice.',
  management: 'Connections',
  drive: 'Connect Drive',
  driveLabel: 'Drive',
  addDrive: 'Add Drive account',
  emailLabel: 'Email',
  calendarLabel: 'Calendar',
  email: 'Connect email',
  calendar: 'Connect calendar',
  connected: 'Connected',
  reconnect: 'Reconnect',
  disconnect: 'Disconnect',
  disconnectGoogleNote:
    'Disconnecting a Google account removes Gmail, Calendar and Drive access for that account. Other connected accounts stay connected. You may need to approve Google sign-in to Atum again.',
  disconnecting: 'Disconnecting…',
  google: 'Google — Gmail and Calendar',
  appleCalendar: 'Calendar on this Mac',
  googleNote:
    'Connect Gmail and Calendar. Gmail can be read and sent after you confirm each send. Calendar can be read and can create or edit personal timed events after you confirm each action.',
  googleDisclosure:
    'Gmail can be read and sent after you confirm each send. Calendar can be read and can create or edit personal timed events after you confirm each action. Content is processed by Gemini through OpenRouter’s protected Google Vertex route and may remain in chat history.',
  driveDisclosure:
    'Drive can be searched and supported files can be read. Content is processed by Gemini through OpenRouter’s protected Google Vertex route and may remain in chat history.',
  workspaceProtectedNote:
    'Connecting Google puts all assistant work in this Atum account on this device on Gemini, including later chats and shared memory. Model choice is fixed to Gemini. Shared or group tasks configured for another model will stop on this device. This protection continues after disconnection because retained content may contain Google data.',
  privacy: 'Privacy Policy',
  continue: 'Continue',
  cancelDisclosure: 'Cancel',
  appleNote:
    'Calendar on this Mac includes the calendars you have added in macOS. macOS requires full calendar access to read your schedule.',
  back: 'Back',
  cancel: 'Cancel connection',
  connecting: 'Waiting for connection…',
  checking: 'Checking connections…',
  retry: 'Try again',
  readOnly:
    'Read Gmail, search and read supported Drive files, and read your calendars. Atum sends email and creates or edits personal timed events only after your confirmation.',
  googleUnavailable: 'Google connection is not available in this build.',
  appleUnavailable: 'This connection is not available on this device.',
  unavailable: 'This connection is not available in this build or on this device.',
  cancelled: 'Connection cancelled. You can try again.',
  timeout: 'The connection timed out. Try again.',
  denied:
    'Access was not granted. Try again and allow the requested access. For Calendar, check Atum in System Settings → Privacy & Security → Calendars.',
  reconnectError: 'This connection needs your authorization again.',
  network: 'Could not reach the service. Check your connection and try again.',
  storage: 'Atum could not access secure storage. Unlock your keychain and try again.',
  account_changed: 'Your Atum account changed. Try connecting again.',
  invalid_input: 'Check your source selection and try again.',
  conflict: 'This item changed before it could be saved. Review it and try again.',
  unsupported: 'This action is not supported for this item.',
  outcome_unknown:
    'Atum sent the request but lost the service’s reply. Check Sent mail or your calendar before trying again to avoid a duplicate.'
}

export const UTILITY_COPY: Record<Locale, Record<keyof typeof en, string>> = {
  en,
  vi: {
    workspaceLocalOnly:
      'Sau khi kết nối Google, máy này tạm dừng tự động đồng bộ và khôi phục trí nhớ, kỹ năng, hướng dẫn trợ lý và thú cưng cá nhân để bảo vệ dữ liệu Google. Thay đổi mới trên máy đối với các nội dung này không được tải lên qua đồng bộ tài khoản. Bản đã lưu trong tài khoản và các máy khác không bị ảnh hưởng. Điều này vẫn tiếp tục sau khi ngắt kết nối.',
    selectionChanged: 'Danh sách lịch đã thay đổi. Hãy chọn lịch cần dùng trong Cài đặt.',
    reviewCalendars: 'Chọn lịch',
    noCalendars: 'Chưa có lịch khả dụng trên máy Mac này.',
    addGoogle: 'Thêm tài khoản Google',
    saving: 'Đang lưu…',
    sourceNote:
      'Atum tìm trong các nguồn được chọn. Lịch Google mới mặc định chưa chọn, trừ lịch chính. Cùng một lịch kết nối qua Google và máy Mac có thể xuất hiện hai lần.',
    management: 'Kết nối',
    drive: 'Kết nối Drive',
    driveLabel: 'Drive',
    addDrive: 'Thêm tài khoản Drive',
    emailLabel: 'Email',
    calendarLabel: 'Lịch',
    email: 'Kết nối email',
    calendar: 'Kết nối lịch',
    connected: 'Đã kết nối',
    reconnect: 'Kết nối lại',
    disconnect: 'Ngắt kết nối',
    disconnectGoogleNote:
      'Ngắt một tài khoản Google sẽ xóa quyền Gmail, Lịch và Drive của tài khoản đó. Các tài khoản khác vẫn kết nối. Bạn có thể cần cấp quyền đăng nhập Atum bằng Google lại.',
    disconnecting: 'Đang ngắt kết nối…',
    google: 'Google — Gmail và Lịch',
    appleCalendar: 'Lịch trên máy Mac này',
    googleNote:
      'Kết nối Gmail và Lịch. Gmail có thể được đọc và gửi sau khi bạn xác nhận từng lần gửi. Lịch có thể được đọc, tạo hoặc chỉnh sửa sự kiện cá nhân có giờ sau khi bạn xác nhận từng thao tác.',
    googleDisclosure:
      'Gmail có thể được đọc và gửi sau khi bạn xác nhận từng lần gửi. Lịch có thể được đọc, tạo hoặc chỉnh sửa sự kiện cá nhân có giờ sau khi bạn xác nhận từng thao tác. Nội dung được xử lý bởi Gemini qua tuyến Google Vertex được bảo vệ của OpenRouter và có thể còn trong lịch sử trò chuyện.',
    driveDisclosure:
      'Drive có thể được tìm kiếm và đọc các tệp được hỗ trợ. Nội dung được xử lý bởi Gemini qua tuyến Google Vertex được bảo vệ của OpenRouter và có thể còn trong lịch sử trò chuyện.',
    workspaceProtectedNote:
      'Kết nối Google sẽ chuyển mọi công việc của trợ lý trong tài khoản Atum này trên thiết bị này sang Gemini, gồm các cuộc trò chuyện sau này và bộ nhớ dùng chung. Bạn chỉ có thể dùng Gemini. Tác vụ dùng chung hoặc nhóm được cấu hình với mô hình khác sẽ dừng trên thiết bị này. Chế độ bảo vệ vẫn tiếp tục sau khi ngắt kết nối vì nội dung lưu lại có thể chứa dữ liệu Google.',
    privacy: 'Chính sách quyền riêng tư',
    continue: 'Tiếp tục',
    cancelDisclosure: 'Hủy',
    appleNote: 'Bao gồm các lịch bạn đã thêm trong macOS. macOS yêu cầu quyền truy cập lịch đầy đủ để đọc lịch trình.',
    back: 'Quay lại',
    cancel: 'Hủy kết nối',
    connecting: 'Đang chờ kết nối…',
    checking: 'Đang kiểm tra kết nối…',
    retry: 'Thử lại',
    readOnly:
      'Đọc Gmail, tìm kiếm và đọc tệp Drive được hỗ trợ, và đọc lịch. Atum chỉ gửi email, tạo hoặc chỉnh sửa sự kiện cá nhân có giờ sau khi bạn xác nhận.',
    googleUnavailable: 'Bản này chưa hỗ trợ kết nối Google.',
    appleUnavailable: 'Thiết bị này chưa hỗ trợ kết nối này.',
    unavailable: 'Kết nối này chưa khả dụng trong bản này hoặc trên thiết bị này.',
    cancelled: 'Đã hủy kết nối. Bạn có thể thử lại.',
    timeout: 'Kết nối quá thời gian chờ. Hãy thử lại.',
    denied:
      'Chưa được cấp quyền. Hãy thử lại và cho phép truy cập. Với Lịch, kiểm tra Atum trong Cài đặt hệ thống → Quyền riêng tư & Bảo mật → Lịch.',
    reconnectError: 'Kết nối này cần bạn cấp quyền lại.',
    network: 'Không thể liên hệ dịch vụ. Kiểm tra mạng và thử lại.',
    storage: 'Atum không thể truy cập kho lưu trữ bảo mật. Mở khóa chuỗi khóa và thử lại.',
    account_changed: 'Tài khoản Atum đã thay đổi. Hãy kết nối lại.',
    invalid_input: 'Kiểm tra nguồn đã chọn và thử lại.',
    conflict: 'Mục này đã thay đổi trước khi lưu. Hãy xem lại và thử lại.',
    unsupported: 'Không hỗ trợ thao tác này cho mục này.',
    outcome_unknown:
      'Atum đã gửi yêu cầu nhưng không nhận được phản hồi từ dịch vụ. Hãy kiểm tra thư Đã gửi hoặc lịch trước khi thử lại để tránh tạo bản trùng.'
  },
  ja: {
    workspaceLocalOnly:
      'Googleに接続すると、データ保護のため、この端末でのメモリ、スキル、アシスタントの指示、個人用ペットの自動同期と復元が停止します。これらのコンテンツへの新しいローカル変更は、アカウント同期ではアップロードされません。アカウントの既存コピーや他の端末には影響しません。接続解除後も継続します。',
    selectionChanged: 'カレンダー一覧が変更されました。設定で使用するカレンダーを選んでください。',
    reviewCalendars: 'カレンダーを確認',
    noCalendars: 'このMacには利用可能なカレンダーがありません。',
    addGoogle: 'Googleアカウントを追加',
    saving: '保存中…',
    sourceNote:
      'チェックしたソースを検索します。新しいGoogleカレンダーはメインのみ選択されます。同じカレンダーをGoogleとMacの両方で接続すると、予定が重複する場合があります。',
    management: '接続',
    drive: 'Driveを接続',
    driveLabel: 'Drive',
    addDrive: 'Driveアカウントを追加',
    emailLabel: 'メール',
    calendarLabel: 'カレンダー',
    email: 'メールを接続',
    calendar: 'カレンダーを接続',
    connected: '接続済み',
    reconnect: '再接続',
    disconnect: '接続を解除',
    disconnectGoogleNote:
      '解除したGoogleアカウントのGmail、カレンダー、Driveへのアクセスを削除します。他のアカウントは接続を維持します。GoogleでのAtumログインに再承認が必要な場合があります。',
    disconnecting: '接続を解除中…',
    google: 'Google — Gmailとカレンダー',
    appleCalendar: 'このMacのカレンダー',
    googleNote:
      'GmailとGoogleカレンダーを接続します。Gmailは、送信ごとの確認後に読み取りと送信ができます。カレンダーは読み取り、確認ごとに個人用の時刻指定イベントを作成または編集できます。',
    googleDisclosure:
      'Gmailは、送信ごとの確認後に読み取りと送信ができます。カレンダーは読み取り、確認ごとに個人用の時刻指定イベントを作成または編集できます。コンテンツはOpenRouterの保護されたGoogle Vertexルートを通じてGeminiで処理され、チャット履歴に残る場合があります。',
    driveDisclosure:
      'Driveは検索でき、対応ファイルを読み取れます。コンテンツはOpenRouterの保護されたGoogle Vertexルートを通じてGeminiで処理され、チャット履歴に残る場合があります。',
    workspaceProtectedNote:
      'Googleに接続すると、この端末のAtumアカウントのすべてのアシスタント処理は、今後のチャットや共有メモリを含めGeminiを使用します。モデルはGeminiに固定されます。別のモデルを使う共有・グループタスクはこの端末では停止します。保存された内容にGoogleデータが含まれる可能性があるため、接続解除後もこの保護は継続します。',
    privacy: 'プライバシーポリシー',
    continue: '続行',
    cancelDisclosure: 'キャンセル',
    appleNote:
      'macOSに追加したカレンダーを使用します。予定の読み取りには、macOSのカレンダーへのフルアクセス権が必要です。',
    back: '戻る',
    cancel: '接続をキャンセル',
    connecting: '接続を待っています…',
    checking: '接続を確認中…',
    retry: '再試行',
    readOnly:
      'Gmailを読み取り、対応するDriveファイルを検索・読み取り、カレンダーを読み取れます。Atumは、確認後にのみメールを送信し、個人用の時刻指定イベントを作成または編集します。',
    googleUnavailable: 'このビルドではGoogleに接続できません。',
    appleUnavailable: 'このデバイスでは利用できません。',
    unavailable: 'このビルドまたはデバイスでは、この接続を利用できません。',
    cancelled: '接続をキャンセルしました。再試行できます。',
    timeout: '接続がタイムアウトしました。再試行してください。',
    denied:
      'アクセスが許可されませんでした。再試行して権限を許可してください。カレンダーは「システム設定 → プライバシーとセキュリティ → カレンダー」でAtumを確認してください。',
    reconnectError: 'もう一度アクセスを許可してください。',
    network: 'サービスに接続できません。ネットワークを確認して再試行してください。',
    storage: '安全なストレージにアクセスできません。キーチェーンのロックを解除して再試行してください。',
    account_changed: 'Atumのアカウントが変わりました。もう一度接続してください。',
    invalid_input: 'ソースの選択を確認して再試行してください。',
    conflict: '保存前にこの項目が変更されました。確認してもう一度試してください。',
    unsupported: 'この項目ではこの操作はサポートされていません。',
    outcome_unknown:
      'Atum はリクエストを送信しましたが、サービスからの応答を受け取れませんでした。重複を避けるため、再試行する前に送信済みメールまたはカレンダーを確認してください。'
  },
  zh: {
    workspaceLocalOnly:
      '连接 Google 后，为保护数据，此电脑将暂停记忆、技能、助手指令和个人宠物的自动同步与恢复。对这些内容的本地更改不会通过账户同步上传。账户中的现有副本及其他电脑不受影响。断开连接后仍继续此保护。',
    selectionChanged: '日历列表已更改。请在设置中选择要使用的日历。',
    reviewCalendars: '选择日历',
    noCalendars: '此 Mac 上尚无可用日历。',
    addGoogle: '添加 Google 账号',
    saving: '正在保存…',
    sourceNote:
      'Atum 搜索已勾选的来源。新增 Google 日历默认仅勾选主日历。同一日历同时通过 Google 和 Mac 连接时，日程可能重复显示。',
    management: '连接',
    drive: '连接 Drive',
    driveLabel: 'Drive',
    addDrive: '添加 Drive 账号',
    emailLabel: '邮箱',
    calendarLabel: '日历',
    email: '连接邮箱',
    calendar: '连接日历',
    connected: '已连接',
    reconnect: '重新连接',
    disconnect: '断开连接',
    disconnectGoogleNote:
      '断开某个 Google 账号会移除该账号的 Gmail、日历和 Drive 权限，其他账号保持连接。你可能需要重新授权通过 Google 登录 Atum。',
    disconnecting: '正在断开连接…',
    google: 'Google — Gmail 和日历',
    appleCalendar: '此 Mac 上的日历',
    googleNote:
      '连接 Gmail 和日历。Gmail 可在你确认每次发送后读取和发送。日历可读取，并在你确认每项操作后创建或编辑个人定时日程。',
    googleDisclosure:
      'Gmail 可在你确认每次发送后读取和发送。日历可读取，并在你确认每项操作后创建或编辑个人定时日程。内容会通过 OpenRouter 受保护的 Google Vertex 路由由 Gemini 处理，并可能保留在聊天记录中。',
    driveDisclosure:
      '可以搜索 Drive 并读取支持的文件。内容会通过 OpenRouter 受保护的 Google Vertex 路由由 Gemini 处理，并可能保留在聊天记录中。',
    workspaceProtectedNote:
      '连接Google后，此设备上Atum账户的所有助手任务（包括以后的聊天和共享记忆）均使用Gemini。模型固定为Gemini。配置为其他模型的共享或群组任务将在此设备上停止。保留内容可能包含Google数据，因此断开连接后仍继续此保护。',
    privacy: '隐私政策',
    continue: '继续',
    cancelDisclosure: '取消',
    appleNote: '包含你在 macOS 中添加的日历。macOS 要求完整日历访问权限才能读取日程。',
    back: '返回',
    cancel: '取消连接',
    connecting: '正在等待连接…',
    checking: '正在检查连接…',
    retry: '重试',
    readOnly:
      '读取 Gmail，搜索和读取支持的 Drive 文件，并读取日历。Atum 只会在你确认后发送邮件，以及创建或编辑个人定时日程。',
    googleUnavailable: '此版本暂不支持连接 Google。',
    appleUnavailable: '此设备无法使用该连接。',
    unavailable: '此版本或设备无法使用该连接。',
    cancelled: '已取消连接，你可以重试。',
    timeout: '连接超时，请重试。',
    denied: '未获得访问权限。请重试并允许访问。日历权限请在“系统设置 → 隐私与安全性 → 日历”中检查 Atum。',
    reconnectError: '此连接需要你重新授权。',
    network: '无法连接服务。请检查网络后重试。',
    storage: 'Atum 无法访问安全存储。请解锁钥匙串后重试。',
    account_changed: 'Atum 账户已更改，请重新连接。',
    invalid_input: '请检查所选来源后重试。',
    conflict: '保存前此项目已更改。请检查后重试。',
    unsupported: '此项目不支持此操作。',
    outcome_unknown: 'Atum 已发送请求，但未收到服务响应。为避免重复，请在重试前检查已发送邮件或日历。'
  },
  'zh-hant': {
    workspaceLocalOnly:
      '連接 Google 後，為保護資料，此電腦將暫停記憶、技能、助理指示和個人寵物的自動同步與還原。對這些內容的本機變更不會透過帳戶同步上傳。帳戶中的現有副本及其他電腦不受影響。中斷連接後仍繼續此保護。',
    selectionChanged: '行事曆列表已變更。請在設定中選擇要使用的行事曆。',
    reviewCalendars: '選擇行事曆',
    noCalendars: '此 Mac 上尚無可用行事曆。',
    addGoogle: '新增 Google 帳號',
    saving: '正在儲存…',
    sourceNote:
      'Atum 搜尋已勾選的來源。新增 Google 行事曆預設僅勾選主行事曆。同一行事曆同時透過 Google 和 Mac 連接時，行程可能重複顯示。',
    management: '連接',
    drive: '連接 Drive',
    driveLabel: 'Drive',
    addDrive: '新增 Drive 帳號',
    emailLabel: '信箱',
    calendarLabel: '行事曆',
    email: '連接信箱',
    calendar: '連接行事曆',
    connected: '已連接',
    reconnect: '重新連接',
    disconnect: '中斷連接',
    disconnectGoogleNote:
      '中斷某個 Google 帳號會移除該帳號的 Gmail、行事曆和 Drive 權限，其他帳號保持連接。你可能需要重新授權透過 Google 登入 Atum。',
    disconnecting: '正在中斷連接…',
    google: 'Google — Gmail 和行事曆',
    appleCalendar: '此 Mac 上的行事曆',
    googleNote:
      '連接 Gmail 和行事曆。Gmail 可在你確認每次傳送後讀取和傳送。行事曆可讀取，並在你確認每項操作後建立或編輯個人定時行程。',
    googleDisclosure:
      'Gmail 可在你確認每次傳送後讀取和傳送。行事曆可讀取，並在你確認每項操作後建立或編輯個人定時行程。內容會透過 OpenRouter 受保護的 Google Vertex 路由由 Gemini 處理，並可能保留在聊天記錄中。',
    driveDisclosure:
      '可以搜尋 Drive 並讀取支援的檔案。內容會透過 OpenRouter 受保護的 Google Vertex 路由由 Gemini 處理，並可能保留在聊天記錄中。',
    workspaceProtectedNote:
      '連接Google後，此裝置上Atum帳戶的所有助理工作（包括之後的聊天和共享記憶）均使用Gemini。模型固定為Gemini。設定為其他模型的共享或群組工作將在此裝置上停止。保留內容可能包含Google資料，因此中斷連接後仍繼續此保護。',
    privacy: '隱私權政策',
    continue: '繼續',
    cancelDisclosure: '取消',
    appleNote: '包含你在 macOS 中加入的行事曆。macOS 要求完整行事曆存取權限才能讀取行程。',
    back: '返回',
    cancel: '取消連接',
    connecting: '正在等待連接…',
    checking: '正在檢查連接…',
    retry: '再試一次',
    readOnly:
      '讀取 Gmail，搜尋和讀取支援的 Drive 檔案，並讀取行事曆。Atum 只會在你確認後傳送郵件，以及建立或編輯個人定時行程。',
    googleUnavailable: '此版本暫不支援連接 Google。',
    appleUnavailable: '此裝置無法使用該連接。',
    unavailable: '此版本或裝置無法使用該連接。',
    cancelled: '已取消連接，你可以再試一次。',
    timeout: '連接逾時，請再試一次。',
    denied: '未獲得存取權限。請再試一次並允許存取。行事曆權限請在「系統設定 → 隱私權與安全性 → 行事曆」中檢查 Atum。',
    reconnectError: '此連接需要你重新授權。',
    network: '無法連接服務。請檢查網路後再試一次。',
    storage: 'Atum 無法存取安全儲存空間。請解鎖鑰匙圈後再試一次。',
    account_changed: 'Atum 帳號已變更，請重新連接。',
    invalid_input: '請檢查所選來源後再試一次。',
    conflict: '儲存前此項目已變更。請檢查後再試一次。',
    unsupported: '此項目不支援此操作。',
    outcome_unknown: 'Atum 已傳送請求，但未收到服務回應。為避免重複，請在再試一次前檢查已寄出郵件或行事曆。'
  }
}
