/**
 * Copy for the Device section of Settings (WS-4, S1 build plan §3/§4). Feature-local, five locales,
 * matching the `matrix-*-copy.ts` precedent so WS-4 does not touch the shared `Translations` type while
 * other lanes run. Vietnamese is the product default and is complete.
 */
export type DeviceSettingsLocale = 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant'

interface DeviceSettingsWords {
  section: string
  intro: string
  statusTitle: string
  ready: string
  reconnecting: string
  guardsTitle: string
  guardIndicator: string
  guardStop: string
  guardSandbox: string
  guardEgress: string
  grantsTitle: string
  grantsIntro: string
  noGrants: string
  revoke: string
  revoking: string
  /** The fold that holds "Allow without asking" (0.19.4 Q4: off the pane's top level). */
  advanced: string
  addTitle: string
  chooseAgent: string
  chooseCapability: string
  allow: string
  allowing: string
  allowFailed: string
  unavailable: string
  active: string
  stopNow: string
  capability: Record<string, string>
}

const words: Record<DeviceSettingsLocale, DeviceSettingsWords> = {
  en: {
    section: 'Device',
    intro: 'When your assistant works on this Mac, it runs under a local sandbox with on-device approvals. These controls are yours and cannot be changed from the cloud.',
    statusTitle: 'This Mac',
    ready: 'Ready to use',
    reconnecting: 'Reconnecting…',
    guardsTitle: 'What protects this Mac',
    guardIndicator: 'A menu-bar indicator shows when your assistant is using this Mac.',
    guardStop: 'Stop ends the current action immediately and blocks the next one.',
    guardSandbox: 'Commands run in a sandbox: credentials, keys and your private folders are off-limits without your approval.',
    guardEgress: 'Network access goes through a local proxy; every network host is logged, and nothing is asked for routine installs.',
    grantsTitle: 'Standing permissions',
    grantsIntro: 'Permissions you granted on this Mac so your assistant is not asked each time. Creating one takes Touch ID; revoke any here.',
    noGrants: 'No standing permissions. Your assistant asks for Touch ID once per task only for administrator commands, mass deletes, the Keychain, saved browser sessions and cloud credentials that can spend money.',
    revoke: 'Revoke',
    revoking: 'Revoking…',
    advanced: 'Advanced',
    addTitle: 'Allow without asking',
    chooseAgent: 'Agent',
    chooseCapability: 'Permission',
    allow: 'Allow with Touch ID',
    allowing: 'Waiting for Touch ID…',
    allowFailed: 'Not added: Touch ID was cancelled.',
    unavailable: 'This Mac cannot run commands for agents right now.',
    active: 'An agent is using this Mac now.',
    stopNow: 'Stop now',
    capability: {
      ssh_agent: 'Use the SSH agent',
      keychain: 'Use the Keychain',
      browser_store: 'Use browser sessions',
      cloud_cli: 'Use cloud credentials',
      persistence: 'Change startup items',
      network_new_host: 'Reach new hosts',
      sudo: 'Run sudo',
      other_agent_write: "Write another agent's files",
      exec_downloaded: 'Run downloaded code',
      bulk_destructive: 'Bulk delete',
      gui_upload: 'Upload through apps'
    }
  },
  vi: {
    section: 'Thiết bị',
    intro: 'Khi trợ lý của bạn làm việc trên máy Mac này, nó chạy trong một hộp cát cục bộ với phê duyệt ngay trên máy. Các kiểm soát này là của bạn và không thể thay đổi từ đám mây.',
    statusTitle: 'Máy Mac này',
    ready: 'Đang dùng được',
    reconnecting: 'Đang kết nối lại…',
    guardsTitle: 'Điều gì bảo vệ máy Mac này',
    guardIndicator: 'Một chỉ báo trên thanh menu cho biết khi nào trợ lý đang dùng máy Mac này.',
    guardStop: 'Dừng sẽ kết thúc hành động hiện tại ngay lập tức và chặn hành động tiếp theo.',
    guardSandbox: 'Lệnh chạy trong hộp cát: thông tin đăng nhập, khóa và thư mục riêng tư của bạn bị cấm nếu bạn chưa phê duyệt.',
    guardEgress: 'Truy cập mạng đi qua một proxy cục bộ; mọi máy chủ đều được ghi lại và không hỏi khi cài đặt thông thường.',
    grantsTitle: 'Quyền thường trực',
    grantsIntro: 'Những quyền bạn đã cấp trên máy Mac này để trợ lý không phải hỏi mỗi lần. Tạo một quyền cần Touch ID; bạn có thể thu hồi bất kỳ quyền nào tại đây.',
    noGrants: 'Chưa có quyền thường trực. Trợ lý chỉ hỏi Touch ID một lần cho mỗi tác vụ, và chỉ với lệnh quản trị, xóa hàng loạt, Chuỗi khóa, phiên trình duyệt đã lưu và thông tin đám mây có thể tốn tiền.',
    revoke: 'Thu hồi',
    revoking: 'Đang thu hồi…',
    advanced: 'Nâng cao',
    addTitle: 'Cho phép không cần hỏi',
    chooseAgent: 'Trợ lý',
    chooseCapability: 'Quyền',
    allow: 'Cho phép bằng Touch ID',
    allowing: 'Đang chờ Touch ID…',
    allowFailed: 'Chưa thêm: Touch ID đã bị huỷ.',
    unavailable: 'Máy Mac này hiện chưa thể chạy lệnh cho trợ lý.',
    active: 'Một trợ lý đang dùng máy Mac này.',
    stopNow: 'Dừng ngay',
    capability: {
      ssh_agent: 'Dùng SSH agent',
      keychain: 'Dùng Keychain',
      browser_store: 'Dùng phiên trình duyệt',
      cloud_cli: 'Dùng CLI đám mây',
      persistence: 'Thay đổi mục khởi động',
      network_new_host: 'Kết nối máy chủ mới',
      sudo: 'Chạy sudo',
      other_agent_write: 'Ghi tệp của trợ lý khác',
      exec_downloaded: 'Chạy mã đã tải về',
      bulk_destructive: 'Xóa hàng loạt',
      gui_upload: 'Tải lên qua ứng dụng'
    }
  },
  ja: {
    section: 'デバイス',
    intro: 'アシスタントがこの Mac で作業するときは、デバイス上の承認を伴うローカルサンドボックス内で実行されます。これらの制御はあなたのもので、クラウドからは変更できません。',
    statusTitle: 'この Mac',
    ready: '使用できます',
    reconnecting: '再接続中…',
    guardsTitle: 'この Mac を守るもの',
    guardIndicator: 'メニューバーのインジケーターが、アシスタントがこの Mac を使用中かどうかを示します。',
    guardStop: '停止すると現在の操作を直ちに終了し、次の操作をブロックします。',
    guardSandbox: 'コマンドはサンドボックスで実行されます。承認なしでは資格情報・鍵・プライベートフォルダーには触れられません。',
    guardEgress: 'ネットワークアクセスはローカルプロキシ経由です。すべてのホストは記録され、通常のインストールでは確認しません。',
    grantsTitle: '常設の許可',
    grantsIntro: 'この Mac で付与した許可で、アシスタントが毎回尋ねないようにします。作成には Touch ID が必要です。ここでいつでも取り消せます。',
    noGrants: '常設の許可はありません。Touch ID を求めるのは、管理者コマンド・大量削除・キーチェーン・保存済みブラウザセッション・課金が発生するクラウド認証情報のときだけで、タスクごとに一度です。',
    revoke: '取り消す',
    revoking: '取り消し中…',
    advanced: '詳細設定',
    addTitle: '確認なしで許可',
    chooseAgent: 'エージェント',
    chooseCapability: '許可',
    allow: 'Touch ID で許可',
    allowing: 'Touch ID を待っています…',
    allowFailed: '追加されませんでした。Touch ID がキャンセルされました。',
    unavailable: 'この Mac は現在エージェントのコマンドを実行できません。',
    active: 'エージェントがこの Mac を使用中です。',
    stopNow: '今すぐ停止',
    capability: {
      ssh_agent: 'SSH エージェントを使用',
      keychain: 'キーチェーンを使用',
      browser_store: 'ブラウザーのセッションを使用',
      cloud_cli: 'クラウド CLI を使用',
      persistence: '起動項目を変更',
      network_new_host: '新しいホストへ接続',
      sudo: 'sudo を実行',
      other_agent_write: '他のエージェントのファイルを書き込み',
      exec_downloaded: 'ダウンロードしたコードを実行',
      bulk_destructive: '一括削除',
      gui_upload: 'アプリ経由でアップロード'
    }
  },
  zh: {
    section: '设备',
    intro: '当助手在这台 Mac 上工作时，它会在带有本机审批的本地沙盒中运行。这些控制归你所有，无法从云端更改。',
    statusTitle: '这台 Mac',
    ready: '可以使用',
    reconnecting: '正在重新连接…',
    guardsTitle: '保护这台 Mac 的措施',
    guardIndicator: '菜单栏指示器会显示助手何时正在使用这台 Mac。',
    guardStop: '停止会立即结束当前操作并阻止下一个操作。',
    guardSandbox: '命令在沙盒中运行：未经你批准，无法访问凭据、密钥和你的私人文件夹。',
    guardEgress: '网络访问通过本地代理；所有主机都会被记录，常规安装不会询问你。',
    grantsTitle: '常驻权限',
    grantsIntro: '你在这台 Mac 上授予的权限，使助手不必每次询问。创建需要 Touch ID；你可以在此撤销任意一项。',
    noGrants: '没有常驻权限。仅在管理员命令、批量删除、钥匙串、已保存的浏览器会话和可能产生费用的云凭据时，每个任务请求一次 Touch ID。',
    revoke: '撤销',
    revoking: '正在撤销…',
    advanced: '高级',
    addTitle: '无需询问即允许',
    chooseAgent: '助手',
    chooseCapability: '权限',
    allow: '用 Touch ID 允许',
    allowing: '正在等待 Touch ID…',
    allowFailed: '未添加：Touch ID 已取消。',
    unavailable: '这台 Mac 目前无法为助手运行命令。',
    active: '有助手正在使用这台 Mac。',
    stopNow: '立即停止',
    capability: {
      ssh_agent: '使用 SSH 代理',
      keychain: '使用钥匙串',
      browser_store: '使用浏览器会话',
      cloud_cli: '使用云 CLI',
      persistence: '更改启动项',
      network_new_host: '连接新主机',
      sudo: '运行 sudo',
      other_agent_write: '写入其他助手的文件',
      exec_downloaded: '运行下载的代码',
      bulk_destructive: '批量删除',
      gui_upload: '通过应用上传'
    }
  },
  'zh-hant': {
    section: '裝置',
    intro: '當助理在這台 Mac 上工作時，它會在具備本機審批的本地沙箱中執行。這些控制屬於你，無法從雲端更改。',
    statusTitle: '這台 Mac',
    ready: '可以使用',
    reconnecting: '正在重新連線…',
    guardsTitle: '保護這台 Mac 的措施',
    guardIndicator: '選單列指示器會顯示助理何時正在使用這台 Mac。',
    guardStop: '停止會立即結束目前的操作並阻擋下一個操作。',
    guardSandbox: '指令在沙箱中執行：未經你批准，無法存取憑證、金鑰和你的私人資料夾。',
    guardEgress: '網路存取透過本地代理；所有主機都會被記錄，一般安裝不會詢問你。',
    grantsTitle: '常駐權限',
    grantsIntro: '你在這台 Mac 上授予的權限，讓助理不必每次詢問。建立需要 Touch ID；你可以在此撤銷任何一項。',
    noGrants: '沒有常駐權限。僅在管理者指令、大量刪除、鑰匙圈、已儲存的瀏覽器工作階段和可能產生費用的雲端憑證時，每個任務請求一次 Touch ID。',
    revoke: '撤銷',
    revoking: '正在撤銷…',
    advanced: '進階',
    addTitle: '無需詢問即允許',
    chooseAgent: '助理',
    chooseCapability: '權限',
    allow: '用 Touch ID 允許',
    allowing: '正在等待 Touch ID…',
    allowFailed: '未新增：Touch ID 已取消。',
    unavailable: '這台 Mac 目前無法為助理執行指令。',
    active: '有助理正在使用這台 Mac。',
    stopNow: '立即停止',
    capability: {
      ssh_agent: '使用 SSH 代理',
      keychain: '使用鑰匙圈',
      browser_store: '使用瀏覽器工作階段',
      cloud_cli: '使用雲端 CLI',
      persistence: '變更啟動項目',
      network_new_host: '連線新主機',
      sudo: '執行 sudo',
      other_agent_write: '寫入其他助理的檔案',
      exec_downloaded: '執行下載的程式碼',
      bulk_destructive: '批次刪除',
      gui_upload: '透過應用程式上傳'
    }
  }
}

/** Resolve the Device-section copy for a locale, falling back to English for any unknown locale. */
export function deviceSettingsCopy(locale: string): DeviceSettingsWords {
  return Object.hasOwn(words, locale) ? words[locale as DeviceSettingsLocale] : words.en
}

/** A human label for a protected capability, localized, falling back to the raw id. */
export function capabilityLabel(locale: string, capability: string): string {
  const copy = deviceSettingsCopy(locale)

  return copy.capability[capability] ?? capability
}
