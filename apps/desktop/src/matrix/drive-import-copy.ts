import type { Locale } from '@/i18n'

import type { MatrixDriveImportPlan, MatrixDriveImportSkip } from '../../shared/matrix-drive'
import { MATRIX_DRIVE_IMPORT_LABELS } from '../../shared/matrix-drive-import-copy'

type Refusal = Extract<MatrixDriveImportPlan, { state: 'refused' }>['reason']

interface DriveImportCopy {
  title: string
  help: string
  files: string
  folders: string
  size: string
  notAdded: string
  after: string
  about: string
  warning: string
  blocked: string
  cancel: string
  add: string
  working: string
  close: string
  done: string
  partial: string
  changed: string
  expired: string
  noRoom: string
  unavailable: string
  skipped: Record<MatrixDriveImportSkip, string>
  refused: Record<Refusal, string>
}

export const matrixDriveImportCopy: Record<Locale, DriveImportCopy> = {
  vi: {
    title: MATRIX_DRIVE_IMPORT_LABELS['vi'],
    help: 'Tệp gốc vẫn ở chỗ cũ. Drive chỉ thêm bản sao hoàn chỉnh.',
    files: 'Tệp',
    folders: 'Thư mục',
    size: 'Kích thước',
    notAdded: 'Không thêm: {count} mục',
    after: 'Dung lượng còn lại sau khi thêm',
    about: 'Khoảng {size}',
    warning: 'Trợ lý của bạn có thể không còn đủ chỗ để lưu công việc.',
    blocked: 'Cần {needed}, hiện còn {remaining}.',
    cancel: 'Hủy',
    add: 'Thêm bản sao',
    working: 'Đang thêm…',
    close: 'Đóng',
    done: 'Đã thêm {count} mục.',
    partial: 'Đã dừng. {count} mục đã thêm vẫn ở trong Drive.',
    changed: 'Tệp hoặc Drive đã thay đổi. Hãy chọn lại.',
    expired: 'Lựa chọn này đã hết hạn. Hãy chọn lại.',
    noRoom: 'Drive không còn đủ chỗ. Hãy giải phóng dung lượng rồi chọn lại.',
    unavailable: 'Chưa thể thêm xong. Kiểm tra Drive trước khi thử lại; một số mục có thể đã được thêm.',
    skipped: {
      private: 'Mật khẩu, khóa và cơ sở dữ liệu',
      code: 'Thư mục riêng và thư mục ứng dụng',
      excluded: 'Tệp Drive không đồng bộ',
      shortcuts: 'Lối tắt',
      special: 'Mục không phải tệp thông thường',
      unreadable: 'Mục không đọc được'
    },
    refused: {
      home: 'Chọn tệp hoặc thư mục cụ thể, thay vì cả thư mục người dùng.',
      protected: 'Thư mục này chứa dữ liệu riêng của ứng dụng. Hãy chọn thư mục khác.',
      in_drive: 'Chọn tệp ở ngoài Drive và thư mục chứa Drive.',
      unavailable: 'Không mở được lựa chọn này. Hãy chọn mục bạn có thể đọc.',
      too_many: 'Có quá nhiều mục để kiểm tra. Hãy chọn một phần nhỏ hơn.',
      timeout: 'Kiểm tra mất quá lâu. Hãy chọn một phần nhỏ hơn.',
      quota_unknown: 'Chưa kiểm tra được dung lượng còn lại. Hãy thử lại khi Drive sẵn sàng.',
      staging_volume: 'Drive cần ở cùng ổ đĩa với thư mục Atum để thêm tệp.',
      busy: 'Một lần thêm đang chạy. Hãy chờ hoặc hủy lần đó.',
      empty: 'Không có mục nào có thể thêm trong lựa chọn này.'
    }
  },
  en: {
    title: MATRIX_DRIVE_IMPORT_LABELS['en'],
    help: 'Your originals stay where they are. Drive receives finished copies.',
    files: 'Files',
    folders: 'Folders',
    size: 'Size',
    notAdded: 'Not added: {count} items',
    after: 'Space left after adding',
    about: 'About {size}',
    warning: 'Your assistants may not have room to save their work.',
    blocked: 'Needs {needed}, {remaining} left.',
    cancel: 'Cancel',
    add: 'Add copies',
    working: 'Adding…',
    close: 'Close',
    done: 'Items added: {count}.',
    partial: 'Stopped. {count} already added items stay in Drive.',
    changed: 'The files or Drive changed. Choose them again.',
    expired: 'This selection expired. Choose it again.',
    noRoom: 'Drive no longer has room. Free up space, then choose again.',
    unavailable: 'Couldn’t finish adding. Check Drive before trying again; some items may already be there.',
    skipped: {
      private: 'Passwords, keys and databases',
      code: 'Private and app folders',
      excluded: 'Files Drive does not sync',
      shortcuts: 'Shortcuts',
      special: 'Items that are not regular files',
      unreadable: 'Items that cannot be read'
    },
    refused: {
      home: 'Choose specific files or folders instead of your whole home folder.',
      protected: 'This folder contains private app data. Choose another folder.',
      in_drive: 'Choose files outside Drive and its parent folders.',
      unavailable: 'Couldn’t open that selection. Choose items you can read.',
      too_many: 'There are too many items to check. Choose a smaller selection.',
      timeout: 'Checking took too long. Choose a smaller selection.',
      quota_unknown: 'Couldn’t check the space left. Try again when Drive is ready.',
      staging_volume: 'Drive needs to be on the same disk as your Atum folder to add files.',
      busy: 'An import is running. Wait for it or cancel it.',
      empty: 'There are no items Drive can add in this selection.'
    }
  },
  ja: {
    title: MATRIX_DRIVE_IMPORT_LABELS['ja'],
    help: '元のファイルはそのまま残ります。完成したコピーだけを Drive に追加します。',
    files: 'ファイル',
    folders: 'フォルダ',
    size: 'サイズ',
    notAdded: '追加しない項目：{count}',
    after: '追加後の空き容量',
    about: '約 {size}',
    warning: 'アシスタントが作業を保存するための容量が足りなくなる可能性があります。',
    blocked: '{needed} 必要、残り {remaining}。',
    cancel: 'キャンセル',
    add: 'コピーを追加',
    working: '追加中…',
    close: '閉じる',
    done: '{count} 項目を追加しました。',
    partial: '停止しました。追加済みの {count} 項目は Drive に残ります。',
    changed: 'ファイルまたは Drive が変わりました。もう一度選んでください。',
    expired: '選択の有効期限が切れました。もう一度選んでください。',
    noRoom: 'Drive の空き容量が足りません。容量を空けて、もう一度選んでください。',
    unavailable:
      '追加を完了できませんでした。再試行の前に Drive を確認してください。一部の項目は追加済みの可能性があります。',
    skipped: {
      private: 'パスワード、キー、データベース',
      code: '個人用・アプリのフォルダ',
      excluded: 'Drive が同期しないファイル',
      shortcuts: 'ショートカット',
      special: '通常のファイルではない項目',
      unreadable: '読み取れない項目'
    },
    refused: {
      home: 'ホーム全体ではなく、個別のファイルやフォルダを選んでください。',
      protected: 'アプリの個人データが含まれています。別のフォルダを選んでください。',
      in_drive: 'Drive とその親フォルダの外にあるファイルを選んでください。',
      unavailable: '開けません。読み取れる項目を選んでください。',
      too_many: '項目が多すぎます。選択を少なくしてください。',
      timeout: '確認に時間がかかりすぎました。選択を少なくしてください。',
      quota_unknown: '空き容量を確認できません。Drive の準備後に再試行してください。',
      staging_volume: 'Drive と Atum フォルダを同じディスクに置いてください。',
      busy: '追加処理が進行中です。待つかキャンセルしてください。',
      empty: '追加できる項目がありません。'
    }
  },
  zh: {
    title: MATRIX_DRIVE_IMPORT_LABELS['zh'],
    help: '原文件保留在原处。Drive 只接收完整的副本。',
    files: '文件',
    folders: '文件夹',
    size: '大小',
    notAdded: '未添加：{count} 项',
    after: '添加后剩余空间',
    about: '约 {size}',
    warning: '助手可能没有足够空间保存工作成果。',
    blocked: '需要 {needed}，剩余 {remaining}。',
    cancel: '取消',
    add: '添加副本',
    working: '正在添加…',
    close: '关闭',
    done: '已添加 {count} 项。',
    partial: '已停止。已添加的 {count} 项仍保留在 Drive 中。',
    changed: '文件或 Drive 已改变。请重新选择。',
    expired: '此选择已过期。请重新选择。',
    noRoom: 'Drive 空间已不足。请释放空间后重新选择。',
    unavailable: '未能完成添加。重试前请检查 Drive，部分项目可能已添加。',
    skipped: {
      private: '密码、密钥和数据库',
      code: '私有和应用文件夹',
      excluded: 'Drive 不同步的文件',
      shortcuts: '快捷方式',
      special: '非普通文件项目',
      unreadable: '无法读取的项目'
    },
    refused: {
      home: '请选择具体文件或文件夹，而不是整个用户文件夹。',
      protected: '包含应用私有数据。请选择其他文件夹。',
      in_drive: '请选择 Drive 及其父文件夹以外的文件。',
      unavailable: '无法打开。请选择可读取的项目。',
      too_many: '项目过多。请缩小选择范围。',
      timeout: '检查用时过长。请缩小选择范围。',
      quota_unknown: '无法检查剩余空间。请在 Drive 准备好后重试。',
      staging_volume: 'Drive 需要与 Atum 文件夹位于同一磁盘。',
      busy: '正在添加。请等待或取消当前操作。',
      empty: '没有可以添加的内容。'
    }
  },
  'zh-hant': {
    title: MATRIX_DRIVE_IMPORT_LABELS['zh-hant'],
    help: '原始檔案保留在原處。Drive 只接收完整的副本。',
    files: '檔案',
    folders: '資料夾',
    size: '大小',
    notAdded: '未加入：{count} 項',
    after: '加入後剩餘空間',
    about: '約 {size}',
    warning: '助理可能沒有足夠空間儲存工作成果。',
    blocked: '需要 {needed}，剩餘 {remaining}。',
    cancel: '取消',
    add: '加入副本',
    working: '正在加入…',
    close: '關閉',
    done: '已加入 {count} 項。',
    partial: '已停止。已加入的 {count} 項仍保留在 Drive 中。',
    changed: '檔案或 Drive 已改變。請重新選擇。',
    expired: '此選擇已過期。請重新選擇。',
    noRoom: 'Drive 空間已不足。請釋放空間後重新選擇。',
    unavailable: '未能完成加入。重試前請檢查 Drive，部分項目可能已加入。',
    skipped: {
      private: '密碼、金鑰和資料庫',
      code: '私人和應用程式資料夾',
      excluded: 'Drive 不同步的檔案',
      shortcuts: '捷徑',
      special: '非一般檔案項目',
      unreadable: '無法讀取的項目'
    },
    refused: {
      home: '請選擇特定檔案或資料夾，而不是整個使用者資料夾。',
      protected: '包含應用程式私人資料。請選擇其他資料夾。',
      in_drive: '請選擇 Drive 及其父資料夾以外的檔案。',
      unavailable: '無法開啟。請選擇可讀取的項目。',
      too_many: '項目過多。請縮小選擇範圍。',
      timeout: '檢查用時過長。請縮小選擇範圍。',
      quota_unknown: '無法檢查剩餘空間。請在 Drive 準備好後重試。',
      staging_volume: 'Drive 需要與 Atum 資料夾位於同一磁碟。',
      busy: '正在加入。請等待或取消目前操作。',
      empty: '沒有可以加入的內容。'
    }
  }
}
