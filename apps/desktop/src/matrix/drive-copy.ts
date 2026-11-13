import type { Locale } from '@/i18n'

import type { MatrixDriveIssue, MatrixDriveProblem, MatrixDriveState } from '../../shared/matrix-drive'

import type { DriveKindFamily, MatrixDriveGroupsCopy } from './drive-groups'

export interface MatrixDriveFactsCopy {
  storageLabel: string
  storage: string
  progress: string
  progressOne: string
  underMinute: string
  aboutMinute: string
  aboutHour: string
  aboutMinutes: string
  aboutHours: string
  stale: string
  staleStatus: string
  lowSpace: string
  issueCount: string
  issueOne: string
  /** The header note for files the engine skips on purpose (private, code, excluded patterns); its
   * explanation is `issues.excluded.body`. Desktop never shows `excluded` as an issue card. */
  skipped: { one: string; many: string }
  issues: Record<MatrixDriveIssue['code'], { title: string; body: string }>
}

interface DriveCopy {
  title: string
  comingSoon: string
  comingSoonHelp: string
  more: string
  /** Not connected: the calm hero, its one button, and where the files will live. */
  hero: { title: string; body: string; where: string }
  turnOn: string
  /** The quiet link, and the only way to the folder picker. */
  chooseFolder: string
  /** Explicit recovery after the saved path's filesystem identity changed. */
  chooseFolderAgain: string
  /** `{folder}` is the Drive folder as the person reads it (`~/Atum/Drive`). */
  location: string
  /** A sign-in held back at launch: nothing opened by itself, the browser opens on `action`. */
  signIn: { title: string; body: string; action: string }
  waiting: { title: string; body: string }
  openAgain: string
  cancel: string
  gettingReady: string
  /** Titles when Drive needs the person: a stop, a sign-in, a turn-off that didn't finish. */
  attention: { notOn: string; stopped: string; folder_changed: string; reauthenticate: string; cleanup_failed: string }
  retry: string
  signInAgain: string
  resume: string
  disconnect: string
  forgetFolder: string
  refresh: string
  refreshing: string
  reveal: string
  search: string
  searchEmpty: string
  viewMode: string
  listView: string
  gridView: string
  columnView: string
  galleryView: string
  /** Finder's Group By: the toolbar button, its choices, and the group titles. */
  groups: MatrixDriveGroupsCopy & { title: string; none: string; kind: string; modified: string; size: string }
  /** One item's kind, as the column view's preview and the gallery's caption name it. */
  itemKinds: Record<DriveKindFamily, string>
  forward: string
  quickLook: string
  /** Finder's sidebar: Recents, the Drive's top-level folders under Favorites, the Drive under Locations. */
  browser: { recents: string; recentFiles: string; favorites: string; locations: string; drive: string }
  /** An item's sync badge, said aloud and in its tooltip. */
  sync: { synced: string; pending: string; paused: string }
  preview: {
    ask: string
    open: string
    loading: string
    error: string
    unavailable: string
    kind: string
    modified: string
    size: string
    kinds: {
      pdf: string
      image: string
      text: string
      word: string
      spreadsheet: string
      presentation: string
      file: string
    }
  }
  back: string
  /** The Drive folder itself with nothing in it, and an empty folder inside it. */
  emptyRoot: { title: string; body: string }
  empty: string
  name: string
  size: string
  modified: string
  truncated: string
  failed: string
  useRead: string
  replace: string
  createOutput: string
  outputName: string
  addOutput: string
  useConversation: string
  chooseConversation: string
  selectedFiles: string
  clearSelection: string
  removeSelection: string
  selectionLimit: string
  taskUnavailable: string
  filesUnavailable: string
  deliveryUnknown: string
  /** Local directory scan freshness. This does not describe cloud sync freshness. */
  listing: { current: string; loading: string; partial: string; stale: string }
  /** Engine facts shown on the Drive page. These are presentation only, never instructions. */
  facts: MatrixDriveFactsCopy
  status: Record<MatrixDriveState, string>
  /** What to do, in place of the status line, when connecting stopped for a known reason. */
  problem: Record<MatrixDriveProblem, string>
  /** "About syncing", behind a quiet disclosure: when files sync, the room, and what never syncs
   * (the engine's fixed exclusions, `setAtumRootExclusions`). */
  about: { title: string; running: string; quota: string; private: string; skipped: string }
}

export const matrixDriveCopy: Record<Locale, DriveCopy> = {
  en: {
    title: 'Drive',
    comingSoon: 'Atum Drive is coming soon',
    comingSoonHelp: 'Your synced files will appear here.',
    more: 'More Drive actions',
    hero: {
      title: 'Your files, everywhere',
      body: 'Sync files across your Macs.',
      where: 'Your files will live in Atum › Drive, in your home folder.'
    },
    turnOn: 'Turn on Atum Drive',
    chooseFolder: 'Choose another folder…',
    chooseFolderAgain: 'Choose folder…',
    location: 'Drive folder: {folder}',
    signIn: {
      title: 'Sign in to keep syncing',
      body: 'Your files on this Mac are safe. Sign in with your browser to keep syncing.',
      action: 'Sign in'
    },
    waiting: {
      title: 'Waiting for you in your browser…',
      body: 'Sign in there to turn on Drive. Can’t see the page? Open it again.'
    },
    openAgain: 'Open again',
    cancel: 'Cancel',
    gettingReady: 'Getting your Drive ready — about a minute',
    attention: {
      notOn: 'Drive isn’t on yet',
      stopped: 'Drive stopped',
      folder_changed: 'Choose your Drive folder again',
      reauthenticate: 'Sign in to keep syncing',
      cleanup_failed: 'Drive didn’t finish turning off'
    },
    retry: 'Try again',
    signInAgain: 'Sign in again',
    resume: 'Resume',
    disconnect: 'Turn off Drive',
    forgetFolder: 'Stop using this folder',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    reveal: 'Show in Finder',
    search: 'Search Drive',
    searchEmpty: 'No files match this search.',
    viewMode: 'View',
    listView: 'List',
    gridView: 'Icons',
    columnView: 'Columns',
    galleryView: 'Gallery',
    groups: {
      title: 'Group',
      none: 'None',
      kind: 'Kind',
      modified: 'Date Modified',
      size: 'Size',
      kinds: {
        folder: 'Folders',
        image: 'Images',
        pdf: 'PDF Documents',
        document: 'Documents',
        text: 'Text Documents',
        spreadsheet: 'Spreadsheets',
        presentation: 'Presentations',
        movie: 'Movies',
        music: 'Music',
        archive: 'Archives',
        code: 'Code',
        other: 'Other'
      },
      dates: { today: 'Today', yesterday: 'Yesterday', week: 'Previous 7 Days', month: 'Previous 30 Days' },
      sizes: {
        gb: 'More than 1 GB',
        hundredsMb: '100 MB to 1 GB',
        tensMb: '10 to 100 MB',
        mb: '1 to 10 MB',
        hundredsKb: '100 KB to 1 MB',
        small: 'Less than 100 KB',
        empty: 'Empty',
        folders: 'Folders'
      }
    },
    itemKinds: {
      folder: 'Folder',
      image: 'Image',
      pdf: 'PDF document',
      document: 'Document',
      text: 'Text document',
      spreadsheet: 'Spreadsheet',
      presentation: 'Presentation',
      movie: 'Movie',
      music: 'Audio',
      archive: 'Archive',
      code: 'Code',
      other: 'File'
    },
    forward: 'Forward',
    quickLook: 'Quick Look',
    browser: {
      recents: 'Recents',
      recentFiles: 'Recent files',
      favorites: 'Favorites',
      locations: 'Locations',
      drive: 'Atum Drive'
    },
    sync: { synced: 'Synced', pending: 'Waiting to sync', paused: 'Syncs when Drive is back' },
    preview: {
      ask: 'Ask Atum about this',
      open: 'Open',
      loading: 'Opening preview…',
      error: 'Couldn’t open this preview.',
      unavailable: 'A preview isn’t available for this file.',
      kind: 'Kind',
      modified: 'Modified',
      size: 'Size',
      kinds: {
        pdf: 'PDF document',
        image: 'Image',
        text: 'Text document',
        word: 'Word document',
        spreadsheet: 'Spreadsheet',
        presentation: 'Presentation',
        file: 'File'
      }
    },
    back: 'Back',
    emptyRoot: { title: 'Nothing here yet.', body: 'Drop files into your Atum Drive folder.' },
    empty: 'This folder is empty',
    name: 'Name',
    size: 'Size',
    modified: 'Modified',
    truncated: 'Showing the first 500 items.',
    failed: 'Couldn’t complete this action. Try again.',
    useRead: 'Let assistant read',
    replace: 'Let assistant edit',
    createOutput: 'Save result here',
    outputName: 'Result file name',
    addOutput: 'Add',
    useConversation: 'Back to the chat',
    chooseConversation: 'Open a chat with your assistant to use these files.',
    selectedFiles: 'Files for this conversation',
    clearSelection: 'Clear',
    removeSelection: 'Remove',
    selectionLimit: 'You can use up to four files.',
    taskUnavailable: 'These files can’t be used in this chat yet.',
    filesUnavailable: 'Message sent; files were unavailable.',
    deliveryUnknown: 'Not sure the message was sent. Check the chat before sending again.',
    listing: {
      current: 'Updated locally',
      loading: 'Updating files on this Mac…',
      partial: 'Some files could not be listed. Refresh to try again.',
      stale: 'Showing the last known files on this Mac. Refresh to try again.'
    },
    facts: {
      storageLabel: 'Drive storage',
      aboutMinute: 'about 1 minute',
      aboutHour: 'about 1 hour',
      staleStatus: 'Waiting for an update',
      storage: '{used} of {total}',
      progress: '{done} of {total} files',
      progressOne: '{done} of {total} file',
      issueOne: '1 file',
      underMinute: 'less than a minute',
      aboutMinutes: 'about {count} minutes',
      aboutHours: 'about {count} hours',
      stale: 'Showing last known info. Refresh to update.',
      lowSpace: 'Drive is low on space. Make room before adding more files.',
      issueCount: '{count} files',
      skipped: {
        one: '1 file only on this Mac',
        many: '{count} files only on this Mac'
      },
      issues: {
        drive_full: { title: 'Drive is full', body: 'Open your Drive folder to free up space, then check your files.' },
        conflicts: {
          title: 'Some files have conflicts',
          body: 'Open your Drive folder and check the files that need attention.'
        },
        errors: {
          title: 'Some files couldn’t sync',
          body: 'Open your Drive folder and check the files that couldn’t sync.'
        },
        excluded: {
          title: 'Some files stay on this Mac',
          body: 'Drive leaves private files, .env files, databases and code folders on this Mac.'
        },
        signed_out: { title: 'Drive needs to reconnect', body: 'Try again to keep syncing your files.' }
      }
    },
    status: {
      unavailable: 'Drive is not included in this build yet.',
      disconnected: 'Atum Drive is off',
      authorizing: 'Getting your Drive ready — about a minute',
      connecting: 'Getting your Drive ready — about a minute',
      syncing: 'Syncing…',
      ready: 'Up to date',
      offline: 'You’re offline — your files are still here',
      paused: 'Sync paused',
      reauthenticate: 'Your files on this Mac are safe. Sign in again to keep syncing.',
      error: 'Your files are kept. Try again.',
      cleanup_failed: 'Try again to finish turning Drive off on this Mac.'
    },
    problem: {
      folder_not_empty: 'Your Drive folder already has other files in it. Move them out, or choose another folder.',
      folder_nested_taken: 'There’s already a Drive folder there with other files in it. Choose another folder.',
      folder_home: 'Drive can’t use that folder. Choose one inside your home folder.',
      folder_protected: 'That folder belongs to an app. Choose a folder of your own.',
      folder_in_drive: 'That folder is inside another Drive folder. Choose one somewhere else.',
      folder_other_drive: 'That folder is already used by another Atum Drive. Choose another folder.',
      folder_unavailable: 'Drive can’t open that folder. Choose a folder you can edit.',
      folder_changed:
        'The saved Drive folder was moved or replaced. Atum did not use the changed folder. Choose that folder again or choose another one, or stop using it on this Mac.',
      folder_refused: 'Drive can’t use that folder. Choose another folder.',
      engine: 'Drive couldn’t start on this Mac. Try again; if it keeps happening, update Atum.',
      network: 'Couldn’t reach Atum Drive. Check your internet connection and try again.',
      sign_in: 'Signing in to Drive didn’t finish. Try again.',
      setting_up: 'Setting up your Drive. This can take a minute.',
      not_allowed: 'Atum Drive isn’t open for this account yet.'
    },
    about: {
      title: 'About syncing',
      running: 'Files sync while Atum is open.',
      quota: 'Each account has 1 GB of storage.',
      private: 'Passwords and private keys are never synced.',
      skipped:
        'Atum also skips files with “token” in the name, .env files, databases, and folders like .git and node_modules.'
    }
  },
  vi: {
    title: 'Drive',
    comingSoon: 'Sắp có Atum Drive',
    comingSoonHelp: 'Tệp đồng bộ của bạn sẽ hiện ở đây.',
    more: 'Thêm thao tác Drive',
    hero: {
      title: 'Tệp của bạn, ở mọi nơi',
      body: 'Đồng bộ tệp trên các máy Mac của bạn.',
      where: 'Tệp sẽ nằm trong Atum › Drive, ở thư mục người dùng của bạn.'
    },
    turnOn: 'Bật Atum Drive',
    chooseFolder: 'Chọn thư mục khác…',
    chooseFolderAgain: 'Chọn thư mục…',
    location: 'Thư mục Drive: {folder}',
    signIn: {
      title: 'Đăng nhập để tiếp tục đồng bộ',
      body: 'Tệp trên máy Mac này vẫn còn nguyên. Đăng nhập trong trình duyệt để tiếp tục đồng bộ.',
      action: 'Đăng nhập'
    },
    waiting: {
      title: 'Đang chờ bạn trong trình duyệt…',
      body: 'Đăng nhập ở đó để bật Drive. Không thấy trang? Bấm Mở lại.'
    },
    openAgain: 'Mở lại',
    cancel: 'Hủy',
    gettingReady: 'Đang chuẩn bị Drive, khoảng một phút',
    attention: {
      notOn: 'Drive chưa bật được',
      stopped: 'Drive đã dừng',
      folder_changed: 'Chọn lại thư mục Drive',
      reauthenticate: 'Đăng nhập lại để tiếp tục',
      cleanup_failed: 'Drive chưa tắt xong'
    },
    retry: 'Thử lại',
    signInAgain: 'Đăng nhập lại',
    resume: 'Tiếp tục',
    disconnect: 'Tắt Drive',
    forgetFolder: 'Ngừng dùng thư mục này',
    refresh: 'Làm mới',
    refreshing: 'Đang làm mới…',
    reveal: 'Hiện trong Finder',
    search: 'Tìm trong Drive',
    searchEmpty: 'Không có tệp nào khớp với tìm kiếm này.',
    viewMode: 'Kiểu xem',
    listView: 'Danh sách',
    gridView: 'Biểu tượng',
    columnView: 'Cột',
    galleryView: 'Bộ sưu tập',
    groups: {
      title: 'Nhóm',
      none: 'Không nhóm',
      kind: 'Loại',
      modified: 'Ngày sửa',
      size: 'Kích thước',
      kinds: {
        folder: 'Thư mục',
        image: 'Hình ảnh',
        pdf: 'Tài liệu PDF',
        document: 'Tài liệu',
        text: 'Tài liệu văn bản',
        spreadsheet: 'Bảng tính',
        presentation: 'Bản trình bày',
        movie: 'Phim',
        music: 'Âm thanh',
        archive: 'Tệp nén',
        code: 'Mã nguồn',
        other: 'Khác'
      },
      dates: { today: 'Hôm nay', yesterday: 'Hôm qua', week: '7 ngày qua', month: '30 ngày qua' },
      sizes: {
        gb: 'Trên 1 GB',
        hundredsMb: '100 MB đến 1 GB',
        tensMb: '10 đến 100 MB',
        mb: '1 đến 10 MB',
        hundredsKb: '100 KB đến 1 MB',
        small: 'Dưới 100 KB',
        empty: 'Trống',
        folders: 'Thư mục'
      }
    },
    itemKinds: {
      folder: 'Thư mục',
      image: 'Hình ảnh',
      pdf: 'Tài liệu PDF',
      document: 'Tài liệu',
      text: 'Tài liệu văn bản',
      spreadsheet: 'Bảng tính',
      presentation: 'Bản trình bày',
      movie: 'Phim',
      music: 'Âm thanh',
      archive: 'Tệp nén',
      code: 'Mã nguồn',
      other: 'Tệp'
    },
    forward: 'Tiến tới',
    quickLook: 'Xem nhanh',
    browser: {
      recents: 'Gần đây',
      recentFiles: 'Tệp gần đây',
      favorites: 'Mục ưa thích',
      locations: 'Vị trí',
      drive: 'Atum Drive'
    },
    sync: { synced: 'Đã đồng bộ', pending: 'Đang chờ đồng bộ', paused: 'Sẽ đồng bộ khi Drive hoạt động lại' },
    preview: {
      ask: 'Hỏi Atum về tệp này',
      open: 'Mở',
      loading: 'Đang mở bản xem trước…',
      error: 'Không mở được bản xem trước.',
      unavailable: 'Tệp này không có bản xem trước.',
      kind: 'Loại',
      modified: 'Đã sửa',
      size: 'Kích thước',
      kinds: {
        pdf: 'Tài liệu PDF',
        image: 'Hình ảnh',
        text: 'Tài liệu văn bản',
        word: 'Tài liệu Word',
        spreadsheet: 'Bảng tính',
        presentation: 'Bản trình bày',
        file: 'Tệp'
      }
    },
    back: 'Quay lại',
    emptyRoot: { title: 'Chưa có gì.', body: 'Thả tệp vào thư mục Atum Drive.' },
    empty: 'Thư mục này trống',
    name: 'Tên',
    size: 'Kích thước',
    modified: 'Đã sửa',
    truncated: 'Đang hiển thị 500 mục đầu tiên.',
    failed: 'Chưa hoàn tất thao tác. Hãy thử lại.',
    useRead: 'Cho trợ lý đọc',
    replace: 'Cho trợ lý sửa',
    createOutput: 'Lưu kết quả vào đây',
    outputName: 'Tên tệp kết quả',
    addOutput: 'Thêm',
    useConversation: 'Quay lại trò chuyện',
    chooseConversation: 'Mở cuộc trò chuyện với trợ lý để dùng các tệp này.',
    selectedFiles: 'Tệp cho cuộc trò chuyện này',
    clearSelection: 'Xóa hết',
    removeSelection: 'Xóa',
    selectionLimit: 'Bạn có thể dùng tối đa bốn tệp.',
    taskUnavailable: 'Chưa dùng được các tệp này trong cuộc trò chuyện này.',
    filesUnavailable: 'Đã gửi tin nhắn; tệp không khả dụng.',
    deliveryUnknown: 'Chưa rõ đã gửi. Hãy kiểm tra cuộc trò chuyện.',
    listing: {
      current: 'Đã cập nhật trên máy này',
      loading: 'Đang cập nhật tệp trên máy Mac này…',
      partial: 'Không thể liệt kê một số tệp. Hãy làm mới để thử lại.',
      stale: 'Đang hiển thị các tệp đã biết gần nhất trên máy Mac này. Hãy làm mới để thử lại.'
    },
    facts: {
      storageLabel: 'Dung lượng',
      aboutMinute: 'khoảng 1 phút',
      aboutHour: 'khoảng 1 giờ',
      staleStatus: 'Đang chờ cập nhật',
      storage: '{used} trên {total}',
      progress: '{done} trên {total} tệp',
      progressOne: '{done} trên {total} tệp',
      issueOne: '1 tệp',
      underMinute: 'chưa đến một phút',
      aboutMinutes: 'khoảng {count} phút',
      aboutHours: 'khoảng {count} giờ',
      stale: 'Đang hiển thị thông tin đã biết gần nhất. Hãy làm mới để cập nhật.',
      lowSpace: 'Drive sắp hết dung lượng. Hãy dọn chỗ trước khi thêm tệp.',
      issueCount: '{count} tệp',
      skipped: {
        one: '1 tệp chỉ ở trên máy Mac này',
        many: '{count} tệp chỉ ở trên máy Mac này'
      },
      issues: {
        drive_full: {
          title: 'Drive đã đầy',
          body: 'Mở thư mục Drive để giải phóng dung lượng, rồi kiểm tra tệp của bạn.'
        },
        conflicts: { title: 'Một số tệp bị xung đột', body: 'Mở thư mục Drive và kiểm tra những tệp cần chú ý.' },
        errors: {
          title: 'Một số tệp chưa đồng bộ được',
          body: 'Mở thư mục Drive và kiểm tra những tệp chưa đồng bộ được.'
        },
        excluded: {
          title: 'Một số tệp chỉ ở trên máy Mac này',
          body: 'Drive để tệp riêng tư, tệp .env, cơ sở dữ liệu và thư mục mã lại trên máy Mac này.'
        },
        signed_out: { title: 'Drive cần kết nối lại', body: 'Hãy thử lại để tiếp tục đồng bộ tệp của bạn.' }
      }
    },
    status: {
      unavailable: 'Bản Atum này chưa có Drive.',
      disconnected: 'Atum Drive đang tắt',
      authorizing: 'Đang chuẩn bị Drive, khoảng một phút',
      connecting: 'Đang chuẩn bị Drive, khoảng một phút',
      syncing: 'Đang đồng bộ…',
      ready: 'Đã cập nhật',
      offline: 'Mất mạng, tệp của bạn vẫn ở đây',
      paused: 'Đã tạm dừng đồng bộ',
      reauthenticate: 'Tệp trên máy Mac này vẫn còn nguyên. Đăng nhập lại để tiếp tục đồng bộ.',
      error: 'Tệp của bạn vẫn được giữ nguyên. Hãy thử lại.',
      cleanup_failed: 'Hãy thử lại để tắt hẳn Drive trên máy Mac này.'
    },
    problem: {
      folder_not_empty: 'Thư mục Drive đã có tệp khác. Hãy chuyển chúng ra chỗ khác, hoặc chọn thư mục khác.',
      folder_nested_taken: 'Ở đó đã có một thư mục Drive chứa tệp khác. Hãy chọn thư mục khác.',
      folder_home: 'Drive không dùng được thư mục này. Hãy chọn một thư mục bên trong thư mục người dùng của bạn.',
      folder_protected: 'Thư mục này thuộc về một ứng dụng. Hãy chọn thư mục của riêng bạn.',
      folder_in_drive: 'Thư mục này nằm trong một thư mục Drive khác. Hãy chọn thư mục ở nơi khác.',
      folder_other_drive: 'Thư mục này đang được một Atum Drive khác dùng. Hãy chọn thư mục khác.',
      folder_unavailable: 'Drive không mở được thư mục này. Hãy chọn thư mục mà bạn có quyền sửa.',
      folder_changed:
        'Thư mục Drive đã lưu đã bị di chuyển hoặc thay thế. Atum chưa dùng thư mục đã thay đổi. Hãy chọn lại thư mục đó hoặc chọn thư mục khác, hoặc ngừng dùng thư mục này trên máy Mac.',
      folder_refused: 'Drive không dùng được thư mục này. Hãy chọn thư mục khác.',
      engine: 'Drive chưa khởi động được trên máy Mac này. Hãy thử lại; nếu vẫn vậy, hãy cập nhật Atum.',
      network: 'Chưa kết nối được tới Atum Drive. Hãy kiểm tra kết nối mạng rồi thử lại.',
      sign_in: 'Chưa đăng nhập Drive xong. Hãy thử lại.',
      setting_up: 'Đang thiết lập Drive của bạn. Việc này có thể mất một phút.',
      not_allowed: 'Atum Drive chưa mở cho tài khoản này.'
    },
    about: {
      title: 'Về đồng bộ',
      running: 'Tệp đồng bộ khi Atum đang mở.',
      quota: 'Mỗi tài khoản có 1 GB dung lượng.',
      private: 'Mật khẩu và khóa riêng tư không bao giờ được đồng bộ.',
      skipped:
        'Atum cũng bỏ qua tệp có chữ “token” trong tên, tệp .env, cơ sở dữ liệu và các thư mục như .git, node_modules.'
    }
  },
  ja: {
    title: 'Drive',
    comingSoon: 'Atum Drive は近日公開',
    comingSoonHelp: '同期したファイルがここに表示されます。',
    more: 'Drive のその他の操作',
    hero: {
      title: 'あなたのファイルを、どこでも',
      body: 'Mac 間でファイルを同期します。',
      where: 'ファイルはホームフォルダーの Atum › Drive に置かれます。'
    },
    turnOn: 'Atum Drive をオンにする',
    chooseFolder: '別のフォルダーを選ぶ…',
    chooseFolderAgain: 'フォルダーを選ぶ…',
    location: 'Drive フォルダー：{folder}',
    signIn: {
      title: '同期を続けるにはサインイン',
      body: 'この Mac のファイルはそのままです。ブラウザーでサインインすると同期を再開します。',
      action: 'サインイン'
    },
    waiting: {
      title: 'ブラウザーでの操作を待っています…',
      body: 'ブラウザーでサインインすると Drive がオンになります。ページが見つからない場合は、もう一度開いてください。'
    },
    openAgain: 'もう一度開く',
    cancel: 'キャンセル',
    gettingReady: 'Drive を準備しています（1 分ほど）',
    attention: {
      notOn: 'Drive はまだオンになっていません',
      stopped: 'Drive が止まりました',
      folder_changed: 'Drive フォルダーを選び直してください',
      reauthenticate: '同期を続けるにはサインイン',
      cleanup_failed: 'Drive のオフが完了していません'
    },
    retry: '再試行',
    signInAgain: 'もう一度サインイン',
    resume: '再開',
    disconnect: 'Drive をオフにする',
    forgetFolder: 'このフォルダーの使用をやめる',
    refresh: '更新',
    refreshing: '更新中…',
    reveal: 'Finder に表示',
    search: 'Drive を検索',
    searchEmpty: 'この検索に一致するファイルはありません。',
    viewMode: '表示',
    listView: 'リスト',
    gridView: 'アイコン',
    columnView: 'カラム',
    galleryView: 'ギャラリー',
    groups: {
      title: 'グループ',
      none: 'なし',
      kind: '種類',
      modified: '変更日',
      size: 'サイズ',
      kinds: {
        folder: 'フォルダー',
        image: '画像',
        pdf: 'PDF 書類',
        document: '書類',
        text: 'テキスト書類',
        spreadsheet: 'スプレッドシート',
        presentation: 'プレゼンテーション',
        movie: 'ムービー',
        music: 'オーディオ',
        archive: 'アーカイブ',
        code: 'コード',
        other: 'その他'
      },
      dates: { today: '今日', yesterday: '昨日', week: '過去 7 日間', month: '過去 30 日間' },
      sizes: {
        gb: '1 GB 超',
        hundredsMb: '100 MB〜1 GB',
        tensMb: '10〜100 MB',
        mb: '1〜10 MB',
        hundredsKb: '100 KB〜1 MB',
        small: '100 KB 未満',
        empty: '空',
        folders: 'フォルダー'
      }
    },
    itemKinds: {
      folder: 'フォルダー',
      image: '画像',
      pdf: 'PDF 書類',
      document: '書類',
      text: 'テキスト書類',
      spreadsheet: 'スプレッドシート',
      presentation: 'プレゼンテーション',
      movie: 'ムービー',
      music: 'オーディオ',
      archive: 'アーカイブ',
      code: 'コード',
      other: 'ファイル'
    },
    forward: '進む',
    quickLook: 'クイックルック',
    browser: {
      recents: '最近使った項目',
      recentFiles: '最近のファイル',
      favorites: 'よく使う項目',
      locations: '場所',
      drive: 'Atum Drive'
    },
    sync: { synced: '同期済み', pending: '同期待ち', paused: 'Drive が再開すると同期されます' },
    preview: {
      ask: 'このファイルについて Atum に聞く',
      open: '開く',
      loading: 'プレビューを開いています…',
      error: 'プレビューを開けませんでした。',
      unavailable: 'このファイルのプレビューはありません。',
      kind: '種類',
      modified: '更新日時',
      size: 'サイズ',
      kinds: {
        pdf: 'PDF 書類',
        image: '画像',
        text: 'テキスト書類',
        word: 'Word 書類',
        spreadsheet: 'スプレッドシート',
        presentation: 'プレゼンテーション',
        file: 'ファイル'
      }
    },
    back: '戻る',
    emptyRoot: { title: 'まだ何もありません。', body: 'Atum Drive フォルダーにファイルをドロップしてください。' },
    empty: 'このフォルダーは空です',
    name: '名前',
    size: 'サイズ',
    modified: '更新日時',
    truncated: '最初の 500 件を表示しています。',
    failed: '操作を完了できませんでした。もう一度お試しください。',
    useRead: 'アシスタントに読ませる',
    replace: 'アシスタントに編集させる',
    createOutput: '結果をここに保存',
    outputName: '結果のファイル名',
    addOutput: '追加',
    useConversation: 'チャットに戻る',
    chooseConversation: 'これらのファイルを使うには、アシスタントとのチャットを開いてください。',
    selectedFiles: 'この会話のファイル',
    clearSelection: 'クリア',
    removeSelection: '削除',
    selectionLimit: '使用できるファイルは最大 4 件です。',
    taskUnavailable: 'このチャットではまだこれらのファイルを使えません。',
    filesUnavailable: 'メッセージは送信されましたが、ファイルは利用できませんでした。',
    deliveryUnknown: '配信状況は不明です。会話を確認してください。',
    listing: {
      current: 'この Mac で更新済み',
      loading: 'この Mac のファイルを更新中…',
      partial: '一部のファイルを一覧にできませんでした。更新してもう一度お試しください。',
      stale: 'この Mac で最後に確認したファイルを表示しています。更新してもう一度お試しください。'
    },
    facts: {
      storageLabel: 'ストレージ',
      aboutMinute: '約 1 分',
      aboutHour: '約 1 時間',
      staleStatus: '更新を待っています',
      storage: '{used} / {total}',
      progress: '{done} / {total} ファイル',
      progressOne: '{done} / {total} ファイル',
      issueOne: '1 ファイル',
      underMinute: '1 分未満',
      aboutMinutes: '約 {count} 分',
      aboutHours: '約 {count} 時間',
      stale: '最後に確認した情報を表示しています。更新するには再読み込みしてください。',
      lowSpace: 'Drive の空き容量が少なくなっています。ファイルを追加する前に空き容量を増やしてください。',
      issueCount: '{count} ファイル',
      skipped: {
        one: '1 件のファイルはこの Mac のみ',
        many: '{count} 件のファイルはこの Mac のみ'
      },
      issues: {
        drive_full: {
          title: 'Drive の容量がいっぱいです',
          body: 'Drive フォルダーを開いて空き容量を増やし、ファイルを確認してください。'
        },
        conflicts: {
          title: '競合しているファイルがあります',
          body: 'Drive フォルダーを開き、確認が必要なファイルを確認してください。'
        },
        errors: {
          title: '同期できなかったファイルがあります',
          body: 'Drive フォルダーを開き、同期できなかったファイルを確認してください。'
        },
        excluded: {
          title: 'この Mac にだけ残るファイルがあります',
          body: 'プライベートなファイル、.env ファイル、データベース、コードのフォルダーはこの Mac にだけ残ります。'
        },
        signed_out: {
          title: 'Drive の再接続が必要です',
          body: 'もう一度試して、ファイルの同期を続けてください。'
        }
      }
    },
    status: {
      unavailable: 'このビルドにはまだ Drive が含まれていません。',
      disconnected: 'Atum Drive はオフです',
      authorizing: 'Drive を準備しています（1 分ほど）',
      connecting: 'Drive を準備しています（1 分ほど）',
      syncing: '同期中…',
      ready: '最新の状態です',
      offline: 'オフラインです。ファイルはこの Mac にあります',
      paused: '同期は一時停止中です',
      reauthenticate: 'この Mac のファイルはそのままです。同期を続けるにはもう一度サインインしてください。',
      error: 'ファイルは保持されています。もう一度お試しください。',
      cleanup_failed: 'この Mac で Drive のオフを完了するには、もう一度お試しください。'
    },
    problem: {
      folder_not_empty: 'Drive フォルダーに別のファイルがあります。移動するか、別のフォルダーを選んでください。',
      folder_nested_taken:
        'そこには別のファイルが入った Drive フォルダーがすでにあります。別のフォルダーを選んでください。',
      folder_home: 'このフォルダーは Drive に使えません。ホームフォルダー内のフォルダーを選んでください。',
      folder_protected: 'このフォルダーはアプリが使用しています。自分のフォルダーを選んでください。',
      folder_in_drive: 'このフォルダーは別の Drive フォルダーの中にあります。別の場所を選んでください。',
      folder_other_drive: 'このフォルダーは別の Atum Drive で使われています。別のフォルダーを選んでください。',
      folder_unavailable: 'Drive はこのフォルダーを開けません。編集できるフォルダーを選んでください。',
      folder_changed:
        '保存した Drive フォルダーは移動または置き換えられています。Atum は変更後のフォルダーを使用していません。このフォルダーまたは別のフォルダーを選び直すか、この Mac での使用をやめてください。',
      folder_refused: 'Drive はこのフォルダーを使えません。別のフォルダーを選んでください。',
      engine:
        'この Mac で Drive を起動できませんでした。もう一度お試しください。続く場合は Atum をアップデートしてください。',
      network: 'Atum Drive に接続できませんでした。インターネット接続を確認して、もう一度お試しください。',
      sign_in: 'Drive へのサインインが完了していません。もう一度お試しください。',
      setting_up: 'Drive を準備しています。1 分ほどかかることがあります。',
      not_allowed: 'このアカウントでは Atum Drive をまだ利用できません。'
    },
    about: {
      title: '同期について',
      running: 'ファイルは Atum を開いている間に同期されます。',
      quota: '各アカウントの容量は 1 GB です。',
      private: 'パスワードや秘密鍵が同期されることはありません。',
      skipped:
        '名前に「token」を含むファイル、.env ファイル、データベース、.git や node_modules などのフォルダーも同期されません。'
    }
  },
  zh: {
    title: 'Drive',
    comingSoon: 'Atum Drive 即将推出',
    comingSoonHelp: '同步的文件会显示在这里。',
    more: '更多 Drive 操作',
    hero: {
      title: '你的文件，随处可用',
      body: '在你的 Mac 之间同步文件。',
      where: '文件会放在你个人文件夹的 Atum › Drive 中。'
    },
    turnOn: '开启 Atum Drive',
    chooseFolder: '选择其他文件夹…',
    chooseFolderAgain: '选择文件夹…',
    location: 'Drive 文件夹：{folder}',
    signIn: {
      title: '登录以继续同步',
      body: '这台 Mac 上的文件完好无损。在浏览器中登录即可继续同步。',
      action: '登录'
    },
    waiting: {
      title: '正在等你在浏览器中完成…',
      body: '在浏览器中登录即可开启 Drive。没看到页面？请重新打开。'
    },
    openAgain: '重新打开',
    cancel: '取消',
    gettingReady: '正在准备你的 Drive，大约一分钟',
    attention: {
      notOn: 'Drive 还未开启',
      stopped: 'Drive 已停止',
      folder_changed: '重新选择 Drive 文件夹',
      reauthenticate: '重新登录以继续同步',
      cleanup_failed: 'Drive 尚未完全关闭'
    },
    retry: '重试',
    signInAgain: '重新登录',
    resume: '继续',
    disconnect: '关闭 Drive',
    forgetFolder: '停止使用此文件夹',
    refresh: '刷新',
    refreshing: '正在刷新…',
    reveal: '在 Finder 中显示',
    search: '搜索 Drive',
    searchEmpty: '没有与此搜索匹配的文件。',
    viewMode: '视图',
    listView: '列表',
    gridView: '图标',
    columnView: '分栏',
    galleryView: '画廊',
    groups: {
      title: '分组',
      none: '无',
      kind: '种类',
      modified: '修改日期',
      size: '大小',
      kinds: {
        folder: '文件夹',
        image: '图像',
        pdf: 'PDF 文稿',
        document: '文稿',
        text: '文本文稿',
        spreadsheet: '电子表格',
        presentation: '演示文稿',
        movie: '影片',
        music: '音频',
        archive: '归档',
        code: '代码',
        other: '其他'
      },
      dates: { today: '今天', yesterday: '昨天', week: '过去 7 天', month: '过去 30 天' },
      sizes: {
        gb: '大于 1 GB',
        hundredsMb: '100 MB 到 1 GB',
        tensMb: '10 到 100 MB',
        mb: '1 到 10 MB',
        hundredsKb: '100 KB 到 1 MB',
        small: '小于 100 KB',
        empty: '空',
        folders: '文件夹'
      }
    },
    itemKinds: {
      folder: '文件夹',
      image: '图像',
      pdf: 'PDF 文稿',
      document: '文稿',
      text: '文本文稿',
      spreadsheet: '电子表格',
      presentation: '演示文稿',
      movie: '影片',
      music: '音频',
      archive: '归档',
      code: '代码',
      other: '文件'
    },
    forward: '前进',
    quickLook: '快速查看',
    browser: {
      recents: '最近使用',
      recentFiles: '最近文件',
      favorites: '个人收藏',
      locations: '位置',
      drive: 'Atum Drive'
    },
    sync: { synced: '已同步', pending: '等待同步', paused: 'Drive 恢复后同步' },
    preview: {
      ask: '向 Atum 询问此文件',
      open: '打开',
      loading: '正在打开预览…',
      error: '无法打开此预览。',
      unavailable: '此文件没有可用预览。',
      kind: '类型',
      modified: '修改日期',
      size: '大小',
      kinds: {
        pdf: 'PDF 文档',
        image: '图像',
        text: '文本文档',
        word: 'Word 文档',
        spreadsheet: '电子表格',
        presentation: '演示文稿',
        file: '文件'
      }
    },
    back: '返回',
    emptyRoot: { title: '这里还没有内容。', body: '把文件拖进 Atum Drive 文件夹即可。' },
    empty: '此文件夹为空',
    name: '名称',
    size: '大小',
    modified: '修改时间',
    truncated: '正在显示前 500 项。',
    failed: '未能完成此操作，请重试。',
    useRead: '让助手读取',
    replace: '让助手编辑',
    createOutput: '将结果保存到这里',
    outputName: '结果文件名',
    addOutput: '添加',
    useConversation: '返回聊天',
    chooseConversation: '打开与助手的聊天即可使用这些文件。',
    selectedFiles: '此对话的文件',
    clearSelection: '清除',
    removeSelection: '移除',
    selectionLimit: '最多可使用四个文件。',
    taskUnavailable: '此聊天暂时无法使用这些文件。',
    filesUnavailable: '消息已发送；文件不可用。',
    deliveryUnknown: '发送状态未知。请检查对话。',
    listing: {
      current: '已在这台 Mac 上更新',
      loading: '正在更新这台 Mac 上的文件…',
      partial: '无法列出部分文件。请刷新后重试。',
      stale: '正在显示这台 Mac 上最后已知的文件。请刷新后重试。'
    },
    facts: {
      storageLabel: '存储空间',
      aboutMinute: '大约 1 分钟',
      aboutHour: '大约 1 小时',
      staleStatus: '正在等待更新',
      storage: '{used} / {total}',
      progress: '{done} / {total} 个文件',
      progressOne: '{done} / {total} 个文件',
      issueOne: '1 个文件',
      underMinute: '不到一分钟',
      aboutMinutes: '大约 {count} 分钟',
      aboutHours: '大约 {count} 小时',
      stale: '正在显示上次已知的信息。请刷新以更新。',
      lowSpace: 'Drive 的可用空间不足。请先腾出空间，再添加文件。',
      issueCount: '{count} 个文件',
      skipped: {
        one: '1 个文件仅在这台 Mac 上',
        many: '{count} 个文件仅在这台 Mac 上'
      },
      issues: {
        drive_full: { title: 'Drive 已满', body: '打开 Drive 文件夹以释放空间，然后检查你的文件。' },
        conflicts: { title: '部分文件有冲突', body: '打开 Drive 文件夹，检查需要注意的文件。' },
        errors: { title: '部分文件未能同步', body: '打开 Drive 文件夹，检查未能同步的文件。' },
        excluded: {
          title: '部分文件只保留在这台 Mac 上',
          body: '私密文件、.env 文件、数据库和代码文件夹只保留在这台 Mac 上。'
        },
        signed_out: { title: 'Drive 需要重新连接', body: '请重试以继续同步你的文件。' }
      }
    },
    status: {
      unavailable: '此版本尚未包含 Drive。',
      disconnected: 'Atum Drive 已关闭',
      authorizing: '正在准备你的 Drive，大约一分钟',
      connecting: '正在准备你的 Drive，大约一分钟',
      syncing: '正在同步…',
      ready: '已更新',
      offline: '已离线，你的文件仍在这里',
      paused: '同步已暂停',
      reauthenticate: '这台 Mac 上的文件完好无损。请重新登录以继续同步。',
      error: '你的文件已保留。请重试。',
      cleanup_failed: '请重试，以在这台 Mac 上完全关闭 Drive。'
    },
    problem: {
      folder_not_empty: 'Drive 文件夹里已有其他文件。请把它们移走，或选择其他文件夹。',
      folder_nested_taken: '那里已经有一个装着其他文件的 Drive 文件夹。请选择其他文件夹。',
      folder_home: 'Drive 无法使用这个文件夹。请选择个人文件夹内的文件夹。',
      folder_protected: '这个文件夹由某个应用使用。请选择你自己的文件夹。',
      folder_in_drive: '这个文件夹位于另一个 Drive 文件夹内。请在其他位置选择。',
      folder_other_drive: '这个文件夹已被另一个 Atum Drive 使用。请选择其他文件夹。',
      folder_unavailable: 'Drive 无法打开这个文件夹。请选择一个你可以编辑的文件夹。',
      folder_changed:
        '已保存的 Drive 文件夹被移动或替换。Atum 没有使用发生变化的文件夹。请重新选择该文件夹或选择其他文件夹，或者停止在这台 Mac 上使用它。',
      folder_refused: 'Drive 无法使用这个文件夹。请选择其他文件夹。',
      engine: 'Drive 无法在这台 Mac 上启动。请重试；如果仍然如此，请更新 Atum。',
      network: '无法连接到 Atum Drive。请检查网络连接后重试。',
      sign_in: 'Drive 登录尚未完成。请重试。',
      setting_up: '正在设置你的 Drive，可能需要一分钟。',
      not_allowed: 'Atum Drive 尚未对此账户开放。'
    },
    about: {
      title: '关于同步',
      running: 'Atum 打开时才会同步文件。',
      quota: '每个账户有 1 GB 存储空间。',
      private: '密码和私钥永远不会被同步。',
      skipped: 'Atum 也会跳过名称含“token”的文件、.env 文件、数据库，以及 .git、node_modules 等文件夹。'
    }
  },
  'zh-hant': {
    title: 'Drive',
    comingSoon: 'Atum Drive 即將推出',
    comingSoonHelp: '同步的檔案會顯示在這裡。',
    more: '更多 Drive 操作',
    hero: {
      title: '你的檔案，隨處可用',
      body: '在你的 Mac 之間同步檔案。',
      where: '檔案會放在你個人資料夾的 Atum › Drive 中。'
    },
    turnOn: '開啟 Atum Drive',
    chooseFolder: '選擇其他資料夾…',
    chooseFolderAgain: '選擇資料夾…',
    location: 'Drive 資料夾：{folder}',
    signIn: {
      title: '登入以繼續同步',
      body: '這台 Mac 上的檔案完好無損。在瀏覽器中登入即可繼續同步。',
      action: '登入'
    },
    waiting: {
      title: '正在等你在瀏覽器中完成…',
      body: '在瀏覽器中登入即可開啟 Drive。沒看到頁面？請重新開啟。'
    },
    openAgain: '重新開啟',
    cancel: '取消',
    gettingReady: '正在準備你的 Drive，大約一分鐘',
    attention: {
      notOn: 'Drive 尚未開啟',
      stopped: 'Drive 已停止',
      folder_changed: '重新選擇 Drive 資料夾',
      reauthenticate: '重新登入以繼續同步',
      cleanup_failed: 'Drive 尚未完全關閉'
    },
    retry: '重試',
    signInAgain: '重新登入',
    resume: '繼續',
    disconnect: '關閉 Drive',
    forgetFolder: '停止使用此資料夾',
    refresh: '重新整理',
    refreshing: '正在重新整理…',
    reveal: '在 Finder 中顯示',
    search: '搜尋 Drive',
    searchEmpty: '沒有符合此搜尋的檔案。',
    viewMode: '顯示方式',
    listView: '列表',
    gridView: '圖像',
    columnView: '直欄',
    galleryView: '圖庫',
    groups: {
      title: '群組',
      none: '無',
      kind: '種類',
      modified: '修改日期',
      size: '大小',
      kinds: {
        folder: '資料夾',
        image: '影像',
        pdf: 'PDF 文件',
        document: '文件',
        text: '文字文件',
        spreadsheet: '試算表',
        presentation: '簡報',
        movie: '影片',
        music: '音訊',
        archive: '封存檔',
        code: '程式碼',
        other: '其他'
      },
      dates: { today: '今天', yesterday: '昨天', week: '過去 7 天', month: '過去 30 天' },
      sizes: {
        gb: '大於 1 GB',
        hundredsMb: '100 MB 至 1 GB',
        tensMb: '10 至 100 MB',
        mb: '1 至 10 MB',
        hundredsKb: '100 KB 至 1 MB',
        small: '小於 100 KB',
        empty: '空白',
        folders: '資料夾'
      }
    },
    itemKinds: {
      folder: '資料夾',
      image: '影像',
      pdf: 'PDF 文件',
      document: '文件',
      text: '文字文件',
      spreadsheet: '試算表',
      presentation: '簡報',
      movie: '影片',
      music: '音訊',
      archive: '封存檔',
      code: '程式碼',
      other: '檔案'
    },
    forward: '向前',
    quickLook: '快速查看',
    browser: {
      recents: '最近使用',
      recentFiles: '最近檔案',
      favorites: '喜好項目',
      locations: '位置',
      drive: 'Atum Drive'
    },
    sync: { synced: '已同步', pending: '等待同步', paused: 'Drive 恢復後同步' },
    preview: {
      ask: '詢問 Atum 關於此檔案',
      open: '開啟',
      loading: '正在開啟預覽…',
      error: '無法開啟此預覽。',
      unavailable: '此檔案沒有可用的預覽。',
      kind: '類型',
      modified: '修改日期',
      size: '大小',
      kinds: {
        pdf: 'PDF 文件',
        image: '影像',
        text: '文字文件',
        word: 'Word 文件',
        spreadsheet: '試算表',
        presentation: '簡報',
        file: '檔案'
      }
    },
    back: '返回',
    emptyRoot: { title: '這裡還沒有內容。', body: '把檔案拖進 Atum Drive 資料夾即可。' },
    empty: '此資料夾為空',
    name: '名稱',
    size: '大小',
    modified: '修改時間',
    truncated: '正在顯示前 500 項。',
    failed: '未能完成此操作，請重試。',
    useRead: '讓助理讀取',
    replace: '讓助理編輯',
    createOutput: '將結果儲存到這裡',
    outputName: '結果檔案名稱',
    addOutput: '新增',
    useConversation: '返回聊天',
    chooseConversation: '開啟與助理的聊天即可使用這些檔案。',
    selectedFiles: '此對話的檔案',
    clearSelection: '清除',
    removeSelection: '移除',
    selectionLimit: '最多可使用四個檔案。',
    taskUnavailable: '此聊天暫時無法使用這些檔案。',
    filesUnavailable: '訊息已傳送；檔案無法使用。',
    deliveryUnknown: '傳送狀態不明。請檢查對話。',
    listing: {
      current: '已在這台 Mac 上更新',
      loading: '正在更新這台 Mac 上的檔案…',
      partial: '無法列出部分檔案。請重新整理後再試一次。',
      stale: '正在顯示這台 Mac 上最後已知的檔案。請重新整理後再試一次。'
    },
    facts: {
      storageLabel: '儲存空間',
      aboutMinute: '約 1 分鐘',
      aboutHour: '約 1 小時',
      staleStatus: '正在等待更新',
      storage: '{used} / {total}',
      progress: '{done} / {total} 個檔案',
      progressOne: '{done} / {total} 個檔案',
      issueOne: '1 個檔案',
      underMinute: '不到一分鐘',
      aboutMinutes: '約 {count} 分鐘',
      aboutHours: '約 {count} 小時',
      stale: '正在顯示上次已知的資訊。請重新整理以更新。',
      lowSpace: 'Drive 的可用空間不足。請先騰出空間，再新增檔案。',
      issueCount: '{count} 個檔案',
      skipped: {
        one: '1 個檔案僅在這台 Mac 上',
        many: '{count} 個檔案僅在這台 Mac 上'
      },
      issues: {
        drive_full: { title: 'Drive 已滿', body: '開啟 Drive 資料夾以釋放空間，然後檢查你的檔案。' },
        conflicts: { title: '部分檔案有衝突', body: '開啟 Drive 資料夾，檢查需要注意的檔案。' },
        errors: { title: '部分檔案未能同步', body: '開啟 Drive 資料夾，檢查未能同步的檔案。' },
        excluded: {
          title: '部分檔案只保留在這台 Mac 上',
          body: '私密檔案、.env 檔案、資料庫和程式碼資料夾只保留在這台 Mac 上。'
        },
        signed_out: { title: 'Drive 需要重新連線', body: '請重試以繼續同步你的檔案。' }
      }
    },
    status: {
      unavailable: '此版本尚未包含 Drive。',
      disconnected: 'Atum Drive 已關閉',
      authorizing: '正在準備你的 Drive，大約一分鐘',
      connecting: '正在準備你的 Drive，大約一分鐘',
      syncing: '正在同步…',
      ready: '已更新',
      offline: '已離線，你的檔案仍在這裡',
      paused: '同步已暫停',
      reauthenticate: '這台 Mac 上的檔案完好無損。請重新登入以繼續同步。',
      error: '你的檔案已保留。請重試。',
      cleanup_failed: '請重試，以在這台 Mac 上完全關閉 Drive。'
    },
    problem: {
      folder_not_empty: 'Drive 資料夾裡已有其他檔案。請把它們移走，或選擇其他資料夾。',
      folder_nested_taken: '那裡已經有一個裝著其他檔案的 Drive 資料夾。請選擇其他資料夾。',
      folder_home: 'Drive 無法使用這個資料夾。請選擇個人資料夾內的資料夾。',
      folder_protected: '這個資料夾由某個 App 使用。請選擇你自己的資料夾。',
      folder_in_drive: '這個資料夾位於另一個 Drive 資料夾內。請在其他位置選擇。',
      folder_other_drive: '這個資料夾已被另一個 Atum Drive 使用。請選擇其他資料夾。',
      folder_unavailable: 'Drive 無法開啟這個資料夾。請選擇一個你可以編輯的資料夾。',
      folder_changed:
        '已儲存的 Drive 資料夾被移動或取代。Atum 沒有使用發生變化的資料夾。請重新選擇該資料夾或選擇其他資料夾，或者停止在這台 Mac 上使用它。',
      folder_refused: 'Drive 無法使用這個資料夾。請選擇其他資料夾。',
      engine: 'Drive 無法在這台 Mac 上啟動。請重試；如果仍然如此，請更新 Atum。',
      network: '無法連線到 Atum Drive。請檢查網路連線後重試。',
      sign_in: 'Drive 登入尚未完成。請重試。',
      setting_up: '正在設定你的 Drive，可能需要一分鐘。',
      not_allowed: 'Atum Drive 尚未對此帳號開放。'
    },
    about: {
      title: '關於同步',
      running: 'Atum 開啟時才會同步檔案。',
      quota: '每個帳號有 1 GB 儲存空間。',
      private: '密碼和私密金鑰永遠不會被同步。',
      skipped: 'Atum 也會略過名稱含「token」的檔案、.env 檔案、資料庫，以及 .git、node_modules 等資料夾。'
    }
  }
}
