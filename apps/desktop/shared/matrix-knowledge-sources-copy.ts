import type { DesktopLocale } from './desktop-locale'

export type MatrixKnowledgeSourceCopyKind =
  | 'google'
  | 'folders'
  | 'messages'
  | 'browser'
  | 'location'
  | 'teamSpaces'
  | 'unknown'

export interface MatrixKnowledgeSourcesCopy {
  title: string
  unavailable: string
  retry: string
  readFailed: string
  failed: string
  /** One quiet line beside a source whose switch is on; never changes the switch. */
  status: Record<'macOnly' | 'needsPermission' | 'notConnected' | 'needsMac' | 'unavailable', string>
  /** Tooltip addition for a source only assistants on this Mac can read today. */
  macOnlyDetail: string
  names: Record<MatrixKnowledgeSourceCopyKind, string>
  descriptions: Record<MatrixKnowledgeSourceCopyKind, string>
  details: Record<MatrixKnowledgeSourceCopyKind, string>
  /** The folder checklist under Mac folders (first run and Settings). */
  folderAccess: {
    names: Record<'desktop' | 'documents' | 'downloads' | 'icloud', string>
    add: string
    remove: string
    why: string
    fullDisk: string
    closed: string
    openSettings: string
  }
}

export const matrixKnowledgeSourcesCopy: Record<DesktopLocale, MatrixKnowledgeSourcesCopy> = {
  en: {
    title: 'What Atum can read',
    unavailable: 'Source controls aren’t available in this version.',
    retry: 'Retry',
    readFailed: 'Couldn’t load these controls.',
    failed: 'Couldn’t save that switch. Try again.',
    status: {
      macOnly: 'On this Mac only for now.',
      needsPermission: 'Needs permission in System Settings.',
      notConnected: 'Not connected yet.',
      needsMac: 'Needs a Mac.',
      unavailable: 'Not available yet.'
    },
    macOnlyDetail:
      'Assistants running on this Mac read it. Cloud assistants can’t yet, though they can use this Mac’s files and terminal.',
    names: {
      google: 'Google',
      folders: 'Mac folders',
      messages: 'Messages',
      browser: 'Browser',
      location: 'Location',
      teamSpaces: 'Team spaces',
      unknown: 'Other source'
    },
    descriptions: {
      google: 'Shared Gmail, Calendar and Drive.',
      folders: 'Files in folders available to Atum.',
      messages: 'Who you message, when and recent themes.',
      browser: 'Safari and Chrome titles, domains and visit counts.',
      location: 'City and time zone; precise location is not enabled.',
      teamSpaces: 'Channels, projects and chats you belong to.',
      unknown: 'A source from a connected service.'
    },
    details: {
      google:
        'Turning this off stops Google reads without disconnecting your account. Sends and changes always need confirmation.',
      folders: 'Turning this off blocks file and folder search tools on this Mac.',
      messages:
        'Recent text is used only to derive themes. Atum never quotes messages or stores other people’s words and private details.',
      browser: 'Query strings, fragments and sensitive URLs are removed. Atum never stores full URLs in memory.',
      location:
        'Atum uses city-level account sources and this Mac’s time zone. The precise-location helper is not built yet.',
      teamSpaces: 'Turning this off stops the read-only Atum chat source, including team channels.',
      unknown: 'This source was added by a connected service.'
    },
    folderAccess: {
      names: { desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads', icloud: 'iCloud Drive' },
      add: 'Add a folder…',
      remove: 'Remove',
      why: 'macOS asks once for each ticked folder. Atum won’t ask macOS for an unticked one. You can change this in Settings.',
      fullDisk: 'Needs Full Disk Access, which lets Atum read every file on this Mac, unticked folders included. Atum opens System Settings once for you to switch it on.',
      closed: 'macOS kept this closed.',
      openSettings: 'Open System Settings'
    }
  },
  vi: {
    title: 'Atum có thể đọc gì',
    unavailable: 'Phiên bản này chưa có các công tắc nguồn.',
    retry: 'Thử lại',
    readFailed: 'Chưa tải được các công tắc.',
    failed: 'Chưa lưu được công tắc. Hãy thử lại.',
    status: {
      macOnly: 'Hiện chỉ dùng trên máy Mac này.',
      needsPermission: 'Cần cấp quyền trong Cài đặt hệ thống.',
      notConnected: 'Chưa kết nối.',
      needsMac: 'Cần máy Mac.',
      unavailable: 'Chưa khả dụng.'
    },
    macOnlyDetail:
      'Trợ lý chạy trên máy Mac này đọc được nguồn này. Trợ lý trên đám mây chưa đọc được, nhưng vẫn dùng được tệp và Terminal của máy Mac này.',
    names: {
      google: 'Google',
      folders: 'Thư mục trên Mac',
      messages: 'Tin nhắn',
      browser: 'Trình duyệt',
      location: 'Vị trí',
      teamSpaces: 'Không gian nhóm',
      unknown: 'Nguồn khác'
    },
    descriptions: {
      google: 'Gmail, Lịch và Drive đã chia sẻ.',
      folders: 'Tệp trong các thư mục Atum có thể mở.',
      messages: 'Người bạn nhắn, thời gian và chủ đề gần đây.',
      browser: 'Tiêu đề, tên miền và lượt truy cập Safari, Chrome.',
      location: 'Thành phố và múi giờ; chưa bật vị trí chính xác.',
      teamSpaces: 'Kênh, dự án và cuộc trò chuyện bạn tham gia.',
      unknown: 'Một nguồn từ dịch vụ đã kết nối.'
    },
    details: {
      google:
        'Tắt mục này sẽ dừng đọc Google mà không ngắt tài khoản. Mọi thao tác gửi hay thay đổi luôn cần xác nhận.',
      folders: 'Tắt mục này sẽ chặn công cụ đọc và tìm tệp trên máy Mac này.',
      messages:
        'Nội dung gần đây chỉ dùng để rút ra chủ đề. Atum không trích dẫn tin nhắn hay lưu lời nói và chi tiết riêng tư của người khác.',
      browser: 'Chuỗi truy vấn, phần neo và URL nhạy cảm bị loại bỏ. Atum không lưu URL đầy đủ vào bộ nhớ.',
      location:
        'Atum dùng nguồn cấp tài khoản ở mức thành phố và múi giờ của máy Mac. Trợ lý vị trí chính xác chưa được xây dựng.',
      teamSpaces: 'Tắt mục này sẽ dừng nguồn trò chuyện Atum chỉ đọc, gồm cả các kênh nhóm.',
      unknown: 'Nguồn này được thêm bởi một dịch vụ đã kết nối.'
    },
    folderAccess: {
      names: { desktop: 'Màn hình nền', documents: 'Tài liệu', downloads: 'Tải về', icloud: 'iCloud Drive' },
      add: 'Thêm thư mục…',
      remove: 'Gỡ',
      why: 'macOS hỏi một lần cho mỗi thư mục được chọn. Atum sẽ không xin macOS quyền vào thư mục bỏ chọn. Bạn có thể đổi lại trong Cài đặt.',
      fullDisk: 'Cần Quyền truy cập toàn bộ ổ đĩa. Quyền này cho Atum đọc mọi tệp trên máy Mac này, kể cả thư mục bỏ chọn. Atum mở Cài đặt hệ thống một lần để bạn bật.',
      closed: 'macOS chưa mở thư mục này.',
      openSettings: 'Mở Cài đặt hệ thống'
    }
  },
  ja: {
    title: 'Atum が読めるもの',
    unavailable: 'このバージョンではソースを切り替えられません。',
    retry: '再試行',
    readFailed: 'ソース設定を読み込めませんでした。',
    failed: '切り替えを保存できませんでした。もう一度お試しください。',
    status: {
      macOnly: '現在はこの Mac でのみ利用できます。',
      needsPermission: 'システム設定で許可が必要です。',
      notConnected: 'まだ接続されていません。',
      needsMac: 'Mac が必要です。',
      unavailable: 'まだ利用できません。'
    },
    macOnlyDetail:
      'この Mac で動くアシスタントが読み取ります。クラウドのアシスタントはまだ読み取れませんが、この Mac のファイルとターミナルは使えます。',
    names: {
      google: 'Google',
      folders: 'Mac のフォルダ',
      messages: 'メッセージ',
      browser: 'ブラウザ',
      location: '位置情報',
      teamSpaces: 'チームスペース',
      unknown: 'その他のソース'
    },
    descriptions: {
      google: '共有した Gmail、カレンダー、Drive。',
      folders: 'Atum が利用できるフォルダ内のファイル。',
      messages: '相手、時刻、最近の話題。',
      browser: 'Safari と Chrome のタイトル、ドメイン、訪問回数。',
      location: '都市とタイムゾーン。正確な位置情報は未対応です。',
      teamSpaces: '参加中のチャンネル、プロジェクト、チャット。',
      unknown: '接続済みサービスのソース。'
    },
    details: {
      google: 'オフにすると、アカウントを解除せず Google の読み取りを停止します。送信や変更には常に確認が必要です。',
      folders: 'オフにすると、この Mac のファイル読み取りと検索ツールを停止します。',
      messages: '最近の文面は話題の把握だけに使います。メッセージを引用せず、他人の言葉や個人情報を保存しません。',
      browser: 'クエリ、フラグメント、機密性の高い URL は除外します。完全な URL をメモリに保存しません。',
      location:
        '都市レベルのアカウント情報とこの Mac のタイムゾーンを使います。正確な位置情報ヘルパーはまだありません。',
      teamSpaces: 'オフにすると、チームチャンネルを含む読み取り専用の Atum チャットソースを停止します。',
      unknown: '接続済みサービスによって追加されたソースです。'
    },
    folderAccess: {
      names: { desktop: 'デスクトップ', documents: '書類', downloads: 'ダウンロード', icloud: 'iCloud Drive' },
      add: 'フォルダを追加…',
      remove: '削除',
      why: 'チェックしたフォルダごとに macOS が一度だけ確認します。チェックを外したフォルダについて、Atum は macOS にアクセスを求めません。あとから設定で変更できます。',
      fullDisk: 'フルディスクアクセスが必要です。これを許可すると、チェックを外したフォルダも含め、Atum はこの Mac のすべてのファイルを読めます。Atum がシステム設定を一度開くので、そこでオンにしてください。',
      closed: 'macOS がこのフォルダを閉じたままにしました。',
      openSettings: 'システム設定を開く'
    }
  },
  zh: {
    title: 'Atum 可以读取的内容',
    unavailable: '此版本暂不支持来源开关。',
    retry: '重试',
    readFailed: '无法载入这些开关。',
    failed: '无法保存此开关，请重试。',
    status: {
      macOnly: '目前仅限此 Mac。',
      needsPermission: '需要在系统设置中授权。',
      notConnected: '尚未连接。',
      needsMac: '需要 Mac。',
      unavailable: '暂不可用。'
    },
    macOnlyDetail:
      '在此 Mac 上运行的助理可以读取。云端助理暂时无法读取，但仍可使用此 Mac 的文件和终端。',
    names: {
      google: 'Google',
      folders: 'Mac 文件夹',
      messages: '信息',
      browser: '浏览器',
      location: '位置',
      teamSpaces: '团队空间',
      unknown: '其他来源'
    },
    descriptions: {
      google: '已共享的 Gmail、日历和云端硬盘。',
      folders: 'Atum 可访问文件夹中的文件。',
      messages: '联系人、时间和近期主题。',
      browser: 'Safari 与 Chrome 的标题、域名和访问次数。',
      location: '城市和时区；尚未启用精确位置。',
      teamSpaces: '你加入的频道、项目和聊天。',
      unknown: '来自已连接服务的来源。'
    },
    details: {
      google: '关闭后会停止读取 Google，但不会断开账号。发送或更改内容始终需要确认。',
      folders: '关闭后会阻止此 Mac 上的文件读取和搜索工具。',
      messages: '近期文本仅用于归纳主题。Atum 不引用信息，也不保存他人的原话和私人细节。',
      browser: '查询字符串、片段和敏感网址会被移除。Atum 不会在记忆中保存完整网址。',
      location: 'Atum 使用城市级账号来源和此 Mac 的时区。精确位置助手尚未构建。',
      teamSpaces: '关闭后会停止只读的 Atum 聊天来源，包括团队频道。',
      unknown: '此来源由已连接的服务添加。'
    },
    folderAccess: {
      names: { desktop: '桌面', documents: '文稿', downloads: '下载', icloud: 'iCloud 云盘' },
      add: '添加文件夹…',
      remove: '移除',
      why: '每个勾选的文件夹 macOS 只询问一次。对于未勾选的文件夹，Atum 不会向 macOS 请求访问。之后可在设置中更改。',
      fullDisk: '需要“完全磁盘访问权限”。开启后，Atum 可读取此 Mac 上的所有文件，包括未勾选的文件夹。Atum 会打开一次系统设置，供你开启。',
      closed: 'macOS 未开放此文件夹。',
      openSettings: '打开系统设置'
    }
  },
  'zh-hant': {
    title: 'Atum 可以讀取的內容',
    unavailable: '此版本暫不支援來源開關。',
    retry: '重試',
    readFailed: '無法載入這些開關。',
    failed: '無法儲存此開關，請再試一次。',
    status: {
      macOnly: '目前僅限此 Mac。',
      needsPermission: '需要在系統設定中授權。',
      notConnected: '尚未連接。',
      needsMac: '需要 Mac。',
      unavailable: '暫時無法使用。'
    },
    macOnlyDetail:
      '在此 Mac 上執行的助理可以讀取。雲端助理暫時無法讀取，但仍可使用此 Mac 的檔案和終端機。',
    names: {
      google: 'Google',
      folders: 'Mac 資料夾',
      messages: '訊息',
      browser: '瀏覽器',
      location: '位置',
      teamSpaces: '團隊空間',
      unknown: '其他來源'
    },
    descriptions: {
      google: '已分享的 Gmail、行事曆和雲端硬碟。',
      folders: 'Atum 可存取資料夾中的檔案。',
      messages: '聯絡對象、時間和近期主題。',
      browser: 'Safari 與 Chrome 的標題、網域和瀏覽次數。',
      location: '城市和時區；尚未啟用精確位置。',
      teamSpaces: '你加入的頻道、專案和聊天。',
      unknown: '來自已連接服務的來源。'
    },
    details: {
      google: '關閉後會停止讀取 Google，但不會中斷帳號。傳送或更改內容一律需要確認。',
      folders: '關閉後會阻止此 Mac 上的檔案讀取和搜尋工具。',
      messages: '近期文字只用於歸納主題。Atum 不引用訊息，也不儲存他人的原話和私人細節。',
      browser: '查詢字串、片段和敏感網址會被移除。Atum 不會在記憶中儲存完整網址。',
      location: 'Atum 使用城市層級的帳號來源和此 Mac 的時區。精確位置輔助程式尚未建立。',
      teamSpaces: '關閉後會停止唯讀的 Atum 聊天來源，包括團隊頻道。',
      unknown: '此來源由已連接的服務加入。'
    },
    folderAccess: {
      names: { desktop: '桌面', documents: '文件', downloads: '下載項目', icloud: 'iCloud 雲碟' },
      add: '加入檔案夾…',
      remove: '移除',
      why: '每個勾選的檔案夾 macOS 只會詢問一次。對於未勾選的檔案夾，Atum 不會向 macOS 要求取用。之後可在設定中更改。',
      fullDisk: '需要「全磁碟取用權限」。開啟後，Atum 可讀取此 Mac 上的所有檔案，包括未勾選的檔案夾。Atum 會開啟一次系統設定，讓你開啟。',
      closed: 'macOS 未開放此檔案夾。',
      openSettings: '開啟系統設定'
    }
  }
}
