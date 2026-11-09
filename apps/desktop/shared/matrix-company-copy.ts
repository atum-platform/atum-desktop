import type { MatrixCompanyChannelState } from './matrix-company'

export interface MatrixCompanyCopy {
  personal: string
  /** The segment beside Personal in Workplace. */
  company: string
  /** Names the Personal | Company switch for assistive tech. */
  sides: string
  title: string
  refresh: string
  loading: string
  createCompany: string
  newCompany: string
  companyName: string
  create: string
  companies: string
  invitations: string
  accept: string
  projects: string
  channels: string
  companyOverview: string
  resizeSidebar: string
  backToChannels: string
  noChannels: string
  channelName: string
  createChannel: string
  loadingChannels: string
  openChannel: (displayName: string) => string
  channelOpenFailed: string
  channelDetails: string
  channelState: (state: MatrixCompanyChannelState) => string
  searchMessages: string
  searchPlaceholder: string
  searchAction: string
  searchNoResults: string
  searchCoverage: (searched: number, eligible: number) => string
  searchTruncated: string
  searchLoadMore: string
  searchEncryptedUnavailable: (count: number) => string
  searchLoadedHistory: string
  searchInvalidQuery: string
  searchOperators: string
  searchMessagesTab: string
  searchFilesTab: string
  searchFileType: string
  searchFileTypes: Record<'all' | 'images' | 'pdfs' | 'documents' | 'other', string>
  searchNoFiles: string
  searchSuggestions: Record<'from' | 'in' | 'before' | 'after' | 'phrase', string>
  openSearchResult: (channel: string) => string
  openFileResult: (name: string, channel: string) => string
  createProject: string
  projectName: string
  createProjectAction: string
  noCompanies: string
  noProjects: string
  projectSources: string
  projectSourcesDescription: string
  loadingSources: string
  sourcesEmpty: string
  sourcesPending: string
  readerLoading: string
  readerUnavailable: string
  readerCoverage: (state: 'empty' | 'pending' | 'live' | 'paused' | 'attention') => string
  readerGap: (gap: string) => string
  lastIngested: (time: string) => string
  selectedSources: string
  noSelectedSources: string
  availableSources: string
  noAvailableSources: string
  sourceSelected: string
  sourceWithdrawn: string
  sourceAvailable: string
  addSource: string
  removeSource: string
  projectSourcesDisabled: string
  unknownSource: string
  members: (count: number) => string
  emptyTitle: string
  emptyBody: string
  inviteMembersBannerTitle: string
  inviteMembersBannerBody: string
  inviteAction: string
  inviteTitle: string
  inviteBody: string
  inviteHandleLabel: string
  inviteHandlePlaceholder: string
  inviteSubmit: string
  inviteSent: string
  /** One normalized refusal: unknown, agent, already a member or at cap look identical. */
  inviteUnavailable: string
  inviteLimited: string
  inviteRoleValue: string
  membersTitle: string
  memberStateInvited: string
  memberStateRevoking: string
  memberStateRemoved: string
  cancelInviteAction: string
  removeAction: string
  removeTitle: string
  removeBody: string
  removeConfirm: string
  leaveAction: string
  leaveTitle: string
  leaveBody: string
  leaveTitleNamed: (company: string) => string
  leaveReturnBody: string
  leaveConfirm: string
  joinInvitation: (inviter: string, company: string) => string
  joinAction: string
  laterAction: string
  defaultChannelName: string
  convergeFailed: string
  leavePendingCopy: string
  lastAdmin: string
  creationClosed: string
  someone: string
  close: string
  cancel: string
  unavailable: string
  denied: string
  conflict: string
  limit: string
  invalid: string
  missing: string
  authentication: string
  fundingDisabled: string
  cancelled: string
  retry: string
  companyUnavailable: string
  /** Frozen/mobile-export compatibility; T3a no longer renders this placeholder. */
  notProvisioned: string
  admin: string
  member: string
}

const copy: Record<string, MatrixCompanyCopy> = {
  en: {
    personal: 'Personal', company: 'Company', sides: 'Team space', title: 'Team space', refresh: 'Refresh', loading: 'Loading companies…',
    createCompany: 'Create company', newCompany: 'New company', companyName: 'Company name', create: 'Create', companies: 'Your companies',
    invitations: 'Invitations', accept: 'Accept', channels: 'Channels', companyOverview: 'Company overview', resizeSidebar: 'Resize sidebar', backToChannels: 'Back to channels', noChannels: 'No channels yet.',
    channelName: 'Channel name', createChannel: 'Create channel', loadingChannels: 'Loading channels…',
    openChannel: displayName => `Open # ${displayName}`, channelOpenFailed: 'Couldn’t open this channel. It may have changed; try again in a moment.', channelDetails: 'Channel details',
    channelState: state => ({ ready: 'Ready', not_provisioned: 'Preparing', provisioning: 'Preparing', reconciling: 'Updating', failed: 'Needs attention', archived: 'Archived' }[state]),
    searchMessages: 'Search company messages', searchPlaceholder: 'Search messages', searchAction: 'Search',
    searchNoResults: 'No matching messages in the channels you’ve joined.',
    searchCoverage: (searched, eligible) => `Searched ${searched} of ${eligible} ready channels`,
    searchTruncated: 'Showing a limited set of matches. Refine your search to narrow the results.',
    searchLoadMore: 'Show more', searchEncryptedUnavailable: count => `${count} encrypted ${count === 1 ? 'chat is' : 'chats are'} not searchable here.`,
    searchLoadedHistory: 'Showing results from loaded history.', searchInvalidQuery: 'Check the search filters and dates.',
    searchOperators: 'Search filters', searchMessagesTab: 'Messages', searchFilesTab: 'Files', searchFileType: 'File type',
    searchFileTypes: { all: 'All', images: 'Images', pdfs: 'PDFs', documents: 'Documents', other: 'Other' },
    searchNoFiles: 'No matching files in your searchable history.',
    searchSuggestions: { from: 'From a person', in: 'In a channel', before: 'Before a date', after: 'After a date', phrase: 'Exact phrase' },
    openSearchResult: channel => `Open result in # ${channel}`,
    openFileResult: (name, channel) => `Open ${name} in # ${channel}`,
    projects: 'Projects', createProject: 'Create project', projectName: 'Project name', createProjectAction: 'Create project',
    noCompanies: 'You’re not in a company yet.', noProjects: 'No projects yet.',
    projectSources: 'Company brain sources',
    projectSourcesDescription: 'Choose one ready project channel and one published company file. The shared brief comes later; sources stay pending until the hosted reader is connected.',
    loadingSources: 'Loading sources…', sourcesEmpty: 'No sources selected.', sourcesPending: 'Sources selected · reader pending',
    readerLoading: 'Checking reader…', readerUnavailable: 'Reader status unavailable',
    readerCoverage: state => ({ empty: 'No sources selected.', pending: 'Sources selected · reader pending',
      live: 'Reader live', paused: 'Reader paused', attention: 'Reader needs attention' }[state]),
    readerGap: gap => ({ roster_unresolved: 'Waiting for channel access.', backfill_pending: 'Catching up on channel history.',
      history_gap: 'Channel history needs repair.', join_changed: 'Channel access changed.',
      file_unavailable: 'The selected file is unavailable.', lease_contention: 'Another reader is finishing this work.',
      receipt_pending: 'Saving the latest checkpoint.', assignment_unavailable: 'Reader assignment is unavailable.',
      reader_unavailable: 'The hosted reader is unavailable.' }[gap] ?? 'Reader coverage is temporarily incomplete.'),
    lastIngested: time => `Last ingested ${time}`,
    selectedSources: 'Selected sources', noSelectedSources: 'Nothing selected yet.', availableSources: 'Available sources',
    noAvailableSources: 'Link a ready project channel or publish a company file first.', sourceSelected: 'Selected',
    sourceWithdrawn: 'Removed', sourceAvailable: 'Available', addSource: 'Add', removeSource: 'Remove',
    projectSourcesDisabled: 'Company brain sources are turned off for now. Your last change is kept and can be retried when sources return.',
    unknownSource: 'Channel source',
    emptyTitle: 'Create your company', emptyBody: 'A shared place for your team.',
    inviteMembersBannerTitle: 'Invite a teammate', inviteMembersBannerBody: 'Invite someone by their username.',
    inviteAction: 'Invite', inviteTitle: 'Invite a teammate',
    inviteBody: 'Enter an Atum username to send an invitation.',
    inviteHandleLabel: 'Username', inviteHandlePlaceholder: '@username', inviteSubmit: 'Send invitation',
    inviteSent: 'Invitation sent', inviteUnavailable: 'No user was found for that username. Check it and try again.',
    inviteLimited: 'Too many attempts. Try again in a few minutes.', inviteRoleValue: 'Member',
    membersTitle: 'Members', memberStateInvited: 'Invited', memberStateRevoking: 'Removing access', memberStateRemoved: 'Removed',
    cancelInviteAction: 'Cancel invitation',
    removeAction: 'Remove from company', removeTitle: 'Remove from company?',
    removeBody: 'They lose new messages; earlier messages stay visible.',
    removeConfirm: 'Remove from company', leaveAction: 'Leave company', leaveTitle: 'Leave company?',
    leaveBody: 'You lose new messages; earlier messages stay visible.',
    leaveTitleNamed: company => `Leave ${company}?`,
    leaveReturnBody: 'Leave now; returning needs a new invitation.',
    leaveConfirm: 'Leave company',
    joinInvitation: (inviter, company) => `${inviter} invited you to ${company}`,
    joinAction: 'Join', laterAction: 'Not now',
    defaultChannelName: 'general',
    convergeFailed: 'The channel is still being prepared. You can open it when it is ready.',
    leavePendingCopy: 'Finishing your departure…', lastAdmin: 'Make another person an admin before you leave.',
    creationClosed: 'Creating companies is not open yet.', someone: 'Someone', close: 'Close', cancel: 'Cancel',
    members: count => (count === 1 ? '1 member' : `${count} members`),
    unavailable: 'Atum is unreachable. Try again shortly.', denied: 'You no longer have access to this company.',
    conflict: 'This changed in the meantime. Refresh, then try again.', limit: 'This company has reached its limit for now.',
    invalid: 'That didn’t work. Check the name and try again.', missing: 'This company is no longer available.',
    authentication: 'Sign in again to see your companies.', cancelled: 'The request was cancelled.', retry: 'Retry',
    fundingDisabled: 'Shared spending is turned off for now. Your last change is kept; contact support to finish it.',
    companyUnavailable: 'This company is no longer in your list.',
    notProvisioned: 'Team features for projects are coming soon.', admin: 'Admin', member: 'Member'
  },
  vi: {
    personal: 'Cá nhân', company: 'Công ty', sides: 'Không gian nhóm', title: 'Không gian nhóm', refresh: 'Làm mới', loading: 'Đang tải công ty…',
    createCompany: 'Tạo công ty', newCompany: 'Công ty mới', companyName: 'Tên công ty', create: 'Tạo', companies: 'Công ty của bạn',
    invitations: 'Lời mời', accept: 'Chấp nhận', channels: 'Kênh', companyOverview: 'Tổng quan công ty', resizeSidebar: 'Đổi kích thước thanh bên', backToChannels: 'Quay lại kênh', noChannels: 'Chưa có kênh.',
    channelName: 'Tên kênh', createChannel: 'Tạo kênh', loadingChannels: 'Đang tải kênh…',
    openChannel: displayName => `Mở # ${displayName}`, channelOpenFailed: 'Không thể mở kênh này. Kênh có thể đã thay đổi; hãy thử lại sau giây lát.', channelDetails: 'Chi tiết kênh',
    channelState: state => ({ ready: 'Sẵn sàng', not_provisioned: 'Đang chuẩn bị', provisioning: 'Đang chuẩn bị', reconciling: 'Đang cập nhật', failed: 'Cần xử lý', archived: 'Đã lưu trữ' }[state]),
    searchMessages: 'Tìm tin nhắn công ty', searchPlaceholder: 'Tìm tin nhắn', searchAction: 'Tìm',
    searchNoResults: 'Không có tin nhắn phù hợp trong các kênh bạn đã tham gia.',
    searchCoverage: (searched, eligible) => `Đã tìm ${searched}/${eligible} kênh sẵn sàng`,
    searchTruncated: 'Đang hiển thị một số kết quả giới hạn. Hãy thu hẹp tìm kiếm.',
    searchLoadMore: 'Xem thêm', searchEncryptedUnavailable: count => `${count} cuộc trò chuyện mã hóa không thể tìm ở đây.`,
    searchLoadedHistory: 'Đang hiển thị kết quả từ lịch sử đã tải.', searchInvalidQuery: 'Hãy kiểm tra bộ lọc và ngày tìm kiếm.',
    searchOperators: 'Bộ lọc tìm kiếm', searchMessagesTab: 'Tin nhắn', searchFilesTab: 'Tệp', searchFileType: 'Loại tệp',
    searchFileTypes: { all: 'Tất cả', images: 'Hình ảnh', pdfs: 'PDF', documents: 'Tài liệu', other: 'Khác' },
    searchNoFiles: 'Không có tệp phù hợp trong lịch sử có thể tìm kiếm.',
    searchSuggestions: { from: 'Từ một người', in: 'Trong một kênh', before: 'Trước ngày', after: 'Sau ngày', phrase: 'Cụm từ chính xác' },
    openSearchResult: channel => `Mở kết quả trong # ${channel}`,
    openFileResult: (name, channel) => `Mở ${name} trong # ${channel}`,
    projects: 'Dự án', createProject: 'Tạo dự án', projectName: 'Tên dự án', createProjectAction: 'Tạo dự án',
    noCompanies: 'Bạn chưa thuộc công ty nào.', noProjects: 'Chưa có dự án.',
    projectSources: 'Nguồn cho bộ não công ty',
    projectSourcesDescription: 'Chọn một kênh dự án đã sẵn sàng và một tệp công ty đã xuất bản. Bản tóm tắt chung sẽ có sau; nguồn ở trạng thái chờ đến khi trình đọc đám mây được kết nối.',
    loadingSources: 'Đang tải nguồn…', sourcesEmpty: 'Chưa chọn nguồn.', sourcesPending: 'Đã chọn nguồn · đang chờ trình đọc',
    readerLoading: 'Đang kiểm tra trình đọc…', readerUnavailable: 'Không tải được trạng thái trình đọc',
    readerCoverage: state => ({ empty: 'Chưa chọn nguồn.', pending: 'Đã chọn nguồn · đang chờ trình đọc',
      live: 'Trình đọc đang hoạt động', paused: 'Trình đọc đã tạm dừng', attention: 'Trình đọc cần xử lý' }[state]),
    readerGap: gap => ({ roster_unresolved: 'Đang chờ quyền truy cập kênh.', backfill_pending: 'Đang đồng bộ lịch sử kênh.',
      history_gap: 'Lịch sử kênh cần được sửa.', join_changed: 'Quyền truy cập kênh đã thay đổi.',
      file_unavailable: 'Tệp đã chọn hiện không khả dụng.', lease_contention: 'Một trình đọc khác đang hoàn tất công việc.',
      receipt_pending: 'Đang lưu điểm kiểm tra mới nhất.', assignment_unavailable: 'Không có phân công cho trình đọc.',
      reader_unavailable: 'Trình đọc được lưu trữ hiện không khả dụng.' }[gap] ?? 'Phạm vi đọc tạm thời chưa đầy đủ.'),
    lastIngested: time => `Nhập gần nhất ${time}`,
    selectedSources: 'Nguồn đã chọn', noSelectedSources: 'Chưa chọn gì.', availableSources: 'Nguồn có sẵn',
    noAvailableSources: 'Hãy liên kết một kênh dự án đã sẵn sàng hoặc xuất bản tệp công ty trước.', sourceSelected: 'Đã chọn',
    sourceWithdrawn: 'Đã gỡ', sourceAvailable: 'Có sẵn', addSource: 'Thêm', removeSource: 'Gỡ',
    projectSourcesDisabled: 'Nguồn cho bộ não công ty đang tạm tắt. Thay đổi gần nhất vẫn được giữ và có thể thử lại khi nguồn hoạt động trở lại.',
    unknownSource: 'Nguồn kênh',
    emptyTitle: 'Tạo công ty của bạn', emptyBody: 'Một nơi chung cho cả nhóm.',
    inviteMembersBannerTitle: 'Mời đồng nghiệp', inviteMembersBannerBody: 'Mời ai đó bằng tên người dùng.',
    inviteAction: 'Mời', inviteTitle: 'Mời đồng nghiệp',
    inviteBody: 'Nhập tên người dùng Atum để gửi lời mời.',
    inviteHandleLabel: 'Tên người dùng', inviteHandlePlaceholder: '@ten-nguoi-dung', inviteSubmit: 'Gửi lời mời',
    inviteSent: 'Đã gửi lời mời', inviteUnavailable: 'Không tìm thấy người dùng này. Hãy kiểm tra lại tên người dùng.',
    inviteLimited: 'Bạn đã thử quá nhiều lần. Hãy thử lại sau ít phút.', inviteRoleValue: 'Thành viên',
    membersTitle: 'Thành viên', memberStateInvited: 'Đang mời', memberStateRevoking: 'Đang gỡ quyền', memberStateRemoved: 'Đã gỡ',
    cancelInviteAction: 'Hủy lời mời',
    removeAction: 'Gỡ khỏi công ty', removeTitle: 'Gỡ khỏi công ty?',
    removeBody: 'Người này mất tin mới; tin cũ vẫn hiển thị.',
    removeConfirm: 'Gỡ khỏi công ty', leaveAction: 'Rời công ty', leaveTitle: 'Rời công ty?',
    leaveBody: 'Bạn mất tin mới; tin cũ vẫn hiển thị.',
    leaveTitleNamed: company => `Rời công ty ${company}?`,
    leaveReturnBody: 'Rời bây giờ; quay lại cần lời mời mới.',
    leaveConfirm: 'Rời công ty',
    joinInvitation: (inviter, company) => `${inviter} mời bạn vào công ty ${company}`,
    joinAction: 'Tham gia', laterAction: 'Để sau',
    defaultChannelName: 'chung',
    convergeFailed: 'Kênh đang được chuẩn bị. Bạn có thể mở khi kênh sẵn sàng.',
    leavePendingCopy: 'Đang hoàn tất việc rời công ty…', lastAdmin: 'Hãy chuyển quyền quản trị cho người khác trước khi rời.',
    creationClosed: 'Hiện chưa mở tạo công ty.', someone: 'Một người', close: 'Đóng', cancel: 'Hủy',
    members: count => `${count} thành viên`,
    unavailable: 'Chưa kết nối được Atum. Hãy thử lại sau một lát.', denied: 'Bạn không còn quyền truy cập công ty này.',
    conflict: 'Đã có thay đổi trong lúc này. Hãy làm mới rồi thử lại.', limit: 'Công ty này đã đạt giới hạn hiện tại.',
    invalid: 'Chưa thực hiện được. Hãy kiểm tra tên rồi thử lại.', missing: 'Công ty này không còn nữa.',
    authentication: 'Hãy đăng nhập lại để xem công ty của bạn.', cancelled: 'Yêu cầu đã bị hủy.', retry: 'Thử lại',
    fundingDisabled: 'Chi tiêu chung đang tạm tắt. Thay đổi gần nhất của bạn vẫn được giữ; hãy liên hệ hỗ trợ để hoàn tất.',
    companyUnavailable: 'Công ty này không còn trong danh sách của bạn.',
    notProvisioned: 'Tính năng nhóm cho dự án sắp có.', admin: 'Quản trị viên', member: 'Thành viên'
  },
  ja: {
    personal: '個人', company: '会社', sides: 'チームスペース', title: 'チームスペース', refresh: '更新', loading: '会社を読み込んでいます…',
    createCompany: '会社を作成', newCompany: '新しい会社', companyName: '会社名', create: '作成', companies: 'あなたの会社',
    invitations: '招待', accept: '承諾', channels: 'チャンネル', companyOverview: '会社概要', resizeSidebar: 'サイドバーの幅を変更', backToChannels: 'チャンネルに戻る', noChannels: 'チャンネルはまだありません。',
    channelName: 'チャンネル名', createChannel: 'チャンネルを作成', loadingChannels: 'チャンネルを読み込んでいます…',
    openChannel: displayName => `# ${displayName} を開く`, channelOpenFailed: 'このチャンネルを開けませんでした。変更された可能性があります。しばらくしてからもう一度お試しください。', channelDetails: 'チャンネルの詳細',
    channelState: state => ({ ready: '準備完了', not_provisioned: '準備中', provisioning: '準備中', reconciling: '更新中', failed: '対応が必要', archived: 'アーカイブ済み' }[state]),
    searchMessages: '会社のメッセージを検索', searchPlaceholder: 'メッセージを検索', searchAction: '検索',
    searchNoResults: '参加中のチャンネルに一致するメッセージはありません。',
    searchCoverage: (searched, eligible) => `準備済みチャンネル ${eligible} 件中 ${searched} 件を検索`,
    searchTruncated: '一部の検索結果のみを表示しています。検索語を絞り込んでください。',
    searchLoadMore: 'さらに表示', searchEncryptedUnavailable: count => `${count} 件の暗号化チャットはここでは検索できません。`,
    searchLoadedHistory: '読み込み済みの履歴から結果を表示しています。', searchInvalidQuery: '検索フィルターと日付を確認してください。',
    searchOperators: '検索フィルター', searchMessagesTab: 'メッセージ', searchFilesTab: 'ファイル', searchFileType: 'ファイルの種類',
    searchFileTypes: { all: 'すべて', images: '画像', pdfs: 'PDF', documents: '書類', other: 'その他' },
    searchNoFiles: '検索可能な履歴に一致するファイルはありません。',
    searchSuggestions: { from: '送信者', in: 'チャンネル', before: '指定日より前', after: '指定日以降', phrase: '完全一致の語句' },
    openSearchResult: channel => `# ${channel} で結果を開く`,
    openFileResult: (name, channel) => `# ${channel} で ${name} を開く`,
    projects: 'プロジェクト', createProject: 'プロジェクトを作成', projectName: 'プロジェクト名', createProjectAction: 'プロジェクトを作成',
    noCompanies: 'まだどの会社にも所属していません。', noProjects: 'プロジェクトはまだありません。',
    projectSources: '会社ブレインのソース',
    projectSourcesDescription: '準備済みのプロジェクトチャンネル 1 件と公開済みの会社ファイル 1 件を選択します。共有ブリーフは後で追加され、ホスト型リーダーが接続されるまで保留になります。',
    loadingSources: 'ソースを読み込んでいます…', sourcesEmpty: 'ソースは未選択です。', sourcesPending: 'ソース選択済み · リーダー待機中',
    readerLoading: 'リーダーを確認しています…', readerUnavailable: 'リーダーの状態を取得できません',
    readerCoverage: state => ({ empty: 'ソースは未選択です。', pending: 'ソース選択済み · リーダー待機中',
      live: 'リーダー稼働中', paused: 'リーダー一時停止中', attention: 'リーダーの対応が必要' }[state]),
    readerGap: gap => ({ roster_unresolved: 'チャンネルへのアクセスを待っています。', backfill_pending: 'チャンネル履歴を同期しています。',
      history_gap: 'チャンネル履歴の修復が必要です。', join_changed: 'チャンネルアクセスが変更されました。',
      file_unavailable: '選択したファイルを利用できません。', lease_contention: '別のリーダーが処理を完了しています。',
      receipt_pending: '最新のチェックポイントを保存しています。', assignment_unavailable: 'リーダー割り当てを利用できません。',
      reader_unavailable: 'ホスト型リーダーを利用できません。' }[gap] ?? 'リーダーの対象範囲が一時的に不完全です。'),
    lastIngested: time => `最終取り込み ${time}`,
    selectedSources: '選択済みソース', noSelectedSources: 'まだ選択されていません。', availableSources: '利用可能なソース',
    noAvailableSources: '準備済みのプロジェクトチャンネルをリンクするか、会社ファイルを公開してください。', sourceSelected: '選択済み',
    sourceWithdrawn: '削除済み', sourceAvailable: '利用可能', addSource: '追加', removeSource: '削除',
    projectSourcesDisabled: '会社ブレインのソースは一時的にオフです。最後の変更は保持され、ソースが戻ったら再試行できます。',
    unknownSource: 'チャンネルソース',
    emptyTitle: '会社を作成', emptyBody: 'チーム共通の場所です。',
    inviteMembersBannerTitle: '同僚を招待', inviteMembersBannerBody: 'ユーザー名で招待します。',
    inviteAction: '招待', inviteTitle: '同僚を招待',
    inviteBody: 'Atum のユーザー名を入力して招待します。',
    inviteHandleLabel: 'ユーザー名', inviteHandlePlaceholder: '@username', inviteSubmit: '招待を送信',
    inviteSent: '招待を送信しました', inviteUnavailable: 'このユーザー名のユーザーは見つかりませんでした。確認してもう一度お試しください。',
    inviteLimited: '試行回数が多すぎます。数分後にもう一度お試しください。', inviteRoleValue: 'メンバー',
    membersTitle: 'メンバー', memberStateInvited: '招待中', memberStateRevoking: 'アクセス解除中', memberStateRemoved: '解除済み',
    cancelInviteAction: '招待を取り消す',
    removeAction: '会社から削除', removeTitle: '会社から削除しますか？',
    removeBody: '新しいメッセージを失い、以前のメッセージは残ります。',
    removeConfirm: '会社から削除', leaveAction: '会社を退出', leaveTitle: '会社を退出しますか？',
    leaveBody: '新しいメッセージを失い、以前のメッセージは残ります。',
    leaveTitleNamed: company => `${company} を退出しますか？`,
    leaveReturnBody: '退出後、戻るには新しい招待が必要です。',
    leaveConfirm: '会社を退出',
    joinInvitation: (inviter, company) => `${inviter} さんが ${company} に招待しました`,
    joinAction: '参加', laterAction: '後で',
    defaultChannelName: 'general',
    convergeFailed: 'チャンネルを準備しています。準備ができたら開けます。',
    leavePendingCopy: '退出を完了しています…', lastAdmin: '退出する前に他の人を管理者にしてください。',
    creationClosed: '会社の作成はまだ利用できません。', someone: '誰か', close: '閉じる', cancel: 'キャンセル',
    members: count => `メンバー ${count} 人`,
    unavailable: 'Atum に接続できません。しばらくしてから再試行してください。', denied: 'この会社にアクセスできなくなりました。',
    conflict: 'その間に変更がありました。更新してから再試行してください。', limit: 'この会社は現在の上限に達しています。',
    invalid: 'うまくいきませんでした。名前を確認して再試行してください。', missing: 'この会社はもう利用できません。',
    authentication: '会社を表示するには再度サインインしてください。', cancelled: 'リクエストはキャンセルされました。', retry: '再試行',
    fundingDisabled: '共有の支出は一時的にオフです。最後の変更は保持されています。完了するにはサポートに連絡してください。',
    companyUnavailable: 'この会社は一覧にありません。',
    notProvisioned: 'プロジェクトのチーム機能はまもなく利用できます。', admin: '管理者', member: 'メンバー'
  },
  zh: {
    personal: '个人', company: '公司', sides: '团队空间', title: '团队空间', refresh: '刷新', loading: '正在加载公司…',
    createCompany: '创建公司', newCompany: '新公司', companyName: '公司名称', create: '创建', companies: '你的公司',
    invitations: '邀请', accept: '接受', channels: '频道', companyOverview: '公司概览', resizeSidebar: '调整侧边栏宽度', backToChannels: '返回频道', noChannels: '暂无频道。',
    channelName: '频道名称', createChannel: '创建频道', loadingChannels: '正在加载频道…',
    openChannel: displayName => `打开 # ${displayName}`, channelOpenFailed: '无法打开此频道。它可能已发生变化；请稍后重试。', channelDetails: '频道详情',
    channelState: state => ({ ready: '已就绪', not_provisioned: '准备中', provisioning: '准备中', reconciling: '更新中', failed: '需要处理', archived: '已归档' }[state]),
    searchMessages: '搜索公司消息', searchPlaceholder: '搜索消息', searchAction: '搜索',
    searchNoResults: '你已加入的频道中没有匹配消息。',
    searchCoverage: (searched, eligible) => `已搜索 ${searched}/${eligible} 个就绪频道`,
    searchTruncated: '正在显示有限的匹配结果。请缩小搜索范围。',
    searchLoadMore: '显示更多', searchEncryptedUnavailable: count => `${count} 个加密聊天无法在此搜索。`,
    searchLoadedHistory: '正在显示已加载历史记录中的结果。', searchInvalidQuery: '请检查搜索筛选条件和日期。',
    searchOperators: '搜索筛选', searchMessagesTab: '消息', searchFilesTab: '文件', searchFileType: '文件类型',
    searchFileTypes: { all: '全部', images: '图片', pdfs: 'PDF', documents: '文档', other: '其他' },
    searchNoFiles: '可搜索历史记录中没有匹配文件。',
    searchSuggestions: { from: '来自某人', in: '在频道中', before: '早于日期', after: '晚于日期', phrase: '精确短语' },
    openSearchResult: channel => `在 # ${channel} 中打开结果`,
    openFileResult: (name, channel) => `在 # ${channel} 中打开 ${name}`,
    projects: '项目', createProject: '创建项目', projectName: '项目名称', createProjectAction: '创建项目',
    noCompanies: '你还没有加入任何公司。', noProjects: '暂无项目。',
    projectSources: '公司大脑来源',
    projectSourcesDescription: '选择一个已就绪的项目频道和一个已发布的公司文件。共享简报将在后续提供；连接托管读取器前，来源会保持等待状态。',
    loadingSources: '正在加载来源…', sourcesEmpty: '尚未选择来源。', sourcesPending: '已选择来源 · 等待读取器',
    readerLoading: '正在检查读取器…', readerUnavailable: '无法获取读取器状态',
    readerCoverage: state => ({ empty: '尚未选择来源。', pending: '已选择来源 · 等待读取器',
      live: '读取器运行中', paused: '读取器已暂停', attention: '读取器需要处理' }[state]),
    readerGap: gap => ({ roster_unresolved: '正在等待频道访问权限。', backfill_pending: '正在同步频道历史记录。',
      history_gap: '频道历史记录需要修复。', join_changed: '频道访问权限已更改。',
      file_unavailable: '所选文件不可用。', lease_contention: '另一读取器正在完成此工作。',
      receipt_pending: '正在保存最新检查点。', assignment_unavailable: '读取器分配不可用。',
      reader_unavailable: '托管读取器不可用。' }[gap] ?? '读取范围暂时不完整。'),
    lastIngested: time => `上次读取 ${time}`,
    selectedSources: '已选来源', noSelectedSources: '尚未选择。', availableSources: '可用来源',
    noAvailableSources: '请先关联已就绪的项目频道或发布公司文件。', sourceSelected: '已选择',
    sourceWithdrawn: '已移除', sourceAvailable: '可用', addSource: '添加', removeSource: '移除',
    projectSourcesDisabled: '公司大脑来源暂时关闭。你最近的更改已保留，可在来源恢复后重试。',
    unknownSource: '频道来源',
    emptyTitle: '创建你的公司', emptyBody: '团队共享的交流空间。',
    inviteMembersBannerTitle: '邀请同事', inviteMembersBannerBody: '用用户名邀请成员。',
    inviteAction: '邀请', inviteTitle: '邀请同事',
    inviteBody: '输入 Atum 用户名发送邀请。',
    inviteHandleLabel: '用户名', inviteHandlePlaceholder: '@username', inviteSubmit: '发送邀请',
    inviteSent: '邀请已发送', inviteUnavailable: '未找到该用户名的用户。请检查后重试。',
    inviteLimited: '尝试次数过多。请稍后再试。', inviteRoleValue: '成员',
    membersTitle: '成员', memberStateInvited: '邀请中', memberStateRevoking: '正在移除权限', memberStateRemoved: '已移除',
    cancelInviteAction: '取消邀请',
    removeAction: '从公司移除', removeTitle: '从公司移除？',
    removeBody: '对方失去新消息；旧消息仍可见。',
    removeConfirm: '从公司移除', leaveAction: '离开公司', leaveTitle: '离开公司？',
    leaveBody: '你失去新消息；旧消息仍可见。',
    leaveTitleNamed: company => `离开 ${company}？`,
    leaveReturnBody: '离开后需要新邀请才能回来。',
    leaveConfirm: '离开公司',
    joinInvitation: (inviter, company) => `${inviter} 邀请你加入 ${company}`,
    joinAction: '加入', laterAction: '稍后',
    defaultChannelName: 'general',
    convergeFailed: '频道仍在准备中。就绪后即可打开。',
    leavePendingCopy: '正在完成退出…', lastAdmin: '离开前请先将另一位成员设为管理员。',
    creationClosed: '暂未开放创建公司。', someone: '某人', close: '关闭', cancel: '取消',
    members: count => `${count} 名成员`,
    unavailable: '暂时无法连接 Atum。请稍后重试。', denied: '你已无权访问此公司。',
    conflict: '期间已有变更。请刷新后重试。', limit: '此公司已达到当前限制。',
    invalid: '操作未成功。请检查名称后重试。', missing: '此公司已不可用。',
    authentication: '请重新登录以查看你的公司。', cancelled: '请求已取消。', retry: '重试',
    fundingDisabled: '共享支出暂时关闭。你最近的更改已保留；请联系支持完成更改。',
    companyUnavailable: '此公司已不在你的列表中。',
    notProvisioned: '项目的团队功能即将推出。', admin: '管理员', member: '成员'
  },
  'zh-hant': {
    personal: '個人', company: '公司', sides: '團隊空間', title: '團隊空間', refresh: '重新整理', loading: '正在載入公司…',
    createCompany: '建立公司', newCompany: '新公司', companyName: '公司名稱', create: '建立', companies: '你的公司',
    invitations: '邀請', accept: '接受', channels: '頻道', companyOverview: '公司概覽', resizeSidebar: '調整側邊欄寬度', backToChannels: '返回頻道', noChannels: '尚無頻道。',
    channelName: '頻道名稱', createChannel: '建立頻道', loadingChannels: '正在載入頻道…',
    openChannel: displayName => `開啟 # ${displayName}`, channelOpenFailed: '無法開啟此頻道。它可能已變更；請稍後再試。', channelDetails: '頻道詳情',
    channelState: state => ({ ready: '已就緒', not_provisioned: '準備中', provisioning: '準備中', reconciling: '更新中', failed: '需要處理', archived: '已封存' }[state]),
    searchMessages: '搜尋公司訊息', searchPlaceholder: '搜尋訊息', searchAction: '搜尋',
    searchNoResults: '你已加入的頻道中沒有相符訊息。',
    searchCoverage: (searched, eligible) => `已搜尋 ${searched}/${eligible} 個就緒頻道`,
    searchTruncated: '正在顯示有限的相符結果。請縮小搜尋範圍。',
    searchLoadMore: '顯示更多', searchEncryptedUnavailable: count => `${count} 個加密聊天無法在此搜尋。`,
    searchLoadedHistory: '正在顯示已載入歷史記錄中的結果。', searchInvalidQuery: '請檢查搜尋篩選條件和日期。',
    searchOperators: '搜尋篩選', searchMessagesTab: '訊息', searchFilesTab: '檔案', searchFileType: '檔案類型',
    searchFileTypes: { all: '全部', images: '圖片', pdfs: 'PDF', documents: '文件', other: '其他' },
    searchNoFiles: '可搜尋的歷史記錄中沒有相符檔案。',
    searchSuggestions: { from: '來自某人', in: '在頻道中', before: '早於日期', after: '晚於日期', phrase: '精確詞句' },
    openSearchResult: channel => `在 # ${channel} 中開啟結果`,
    openFileResult: (name, channel) => `在 # ${channel} 中開啟 ${name}`,
    projects: '專案', createProject: '建立專案', projectName: '專案名稱', createProjectAction: '建立專案',
    noCompanies: '你還沒有加入任何公司。', noProjects: '尚無專案。',
    projectSources: '公司大腦來源',
    projectSourcesDescription: '選擇一個已就緒的專案頻道和一個已發布的公司檔案。共享簡報將於後續提供；連接託管讀取器前，來源會維持等待狀態。',
    loadingSources: '正在載入來源…', sourcesEmpty: '尚未選擇來源。', sourcesPending: '已選擇來源 · 等待讀取器',
    readerLoading: '正在檢查讀取器…', readerUnavailable: '無法取得讀取器狀態',
    readerCoverage: state => ({ empty: '尚未選擇來源。', pending: '已選擇來源 · 等待讀取器',
      live: '讀取器運作中', paused: '讀取器已暫停', attention: '讀取器需要處理' }[state]),
    readerGap: gap => ({ roster_unresolved: '正在等待頻道存取權。', backfill_pending: '正在同步頻道歷史記錄。',
      history_gap: '頻道歷史記錄需要修復。', join_changed: '頻道存取權已變更。',
      file_unavailable: '所選檔案無法使用。', lease_contention: '另一個讀取器正在完成此工作。',
      receipt_pending: '正在儲存最新檢查點。', assignment_unavailable: '讀取器指派無法使用。',
      reader_unavailable: '託管讀取器無法使用。' }[gap] ?? '讀取範圍暫時不完整。'),
    lastIngested: time => `上次讀取 ${time}`,
    selectedSources: '已選來源', noSelectedSources: '尚未選擇。', availableSources: '可用來源',
    noAvailableSources: '請先連結已就緒的專案頻道或發布公司檔案。', sourceSelected: '已選擇',
    sourceWithdrawn: '已移除', sourceAvailable: '可用', addSource: '加入', removeSource: '移除',
    projectSourcesDisabled: '公司大腦來源暫時關閉。你最近的變更已保留，可在來源恢復後重試。',
    unknownSource: '頻道來源',
    emptyTitle: '建立你的公司', emptyBody: '團隊共用的交流空間。',
    inviteMembersBannerTitle: '邀請同事', inviteMembersBannerBody: '用使用者名稱邀請成員。',
    inviteAction: '邀請', inviteTitle: '邀請同事',
    inviteBody: '輸入 Atum 使用者名稱傳送邀請。',
    inviteHandleLabel: '使用者名稱', inviteHandlePlaceholder: '@username', inviteSubmit: '傳送邀請',
    inviteSent: '邀請已傳送', inviteUnavailable: '找不到此使用者名稱的使用者。請檢查後再試。',
    inviteLimited: '嘗試次數過多。請稍後再試。', inviteRoleValue: '成員',
    membersTitle: '成員', memberStateInvited: '邀請中', memberStateRevoking: '正在移除權限', memberStateRemoved: '已移除',
    cancelInviteAction: '取消邀請',
    removeAction: '從公司移除', removeTitle: '從公司移除？',
    removeBody: '對方失去新訊息；舊訊息仍可見。',
    removeConfirm: '從公司移除', leaveAction: '離開公司', leaveTitle: '離開公司？',
    leaveBody: '你失去新訊息；舊訊息仍可見。',
    leaveTitleNamed: company => `離開 ${company}？`,
    leaveReturnBody: '離開後需要新邀請才能回來。',
    leaveConfirm: '離開公司',
    joinInvitation: (inviter, company) => `${inviter} 邀請你加入 ${company}`,
    joinAction: '加入', laterAction: '稍後',
    defaultChannelName: 'general',
    convergeFailed: '頻道仍在準備中。就緒後即可開啟。',
    leavePendingCopy: '正在完成退出…', lastAdmin: '離開前請先將另一位成員設為管理員。',
    creationClosed: '暫未開放建立公司。', someone: '某人', close: '關閉', cancel: '取消',
    members: count => `${count} 位成員`,
    unavailable: '暫時無法連接 Atum。請稍後再試。', denied: '你已無權存取此公司。',
    conflict: '期間已有變更。請重新整理後再試。', limit: '此公司已達目前限制。',
    invalid: '操作未成功。請檢查名稱後再試。', missing: '此公司已無法使用。',
    authentication: '請重新登入以查看你的公司。', cancelled: '要求已取消。', retry: '重試',
    fundingDisabled: '共用支出暫時關閉。你最近的變更已保留；請聯絡支援完成變更。',
    companyUnavailable: '此公司已不在你的清單中。',
    notProvisioned: '專案的團隊功能即將推出。', admin: '管理員', member: '成員'
  }
}

export function matrixCompanyCopy(locale: string): MatrixCompanyCopy {
  return Object.hasOwn(copy, locale) ? copy[locale]! : copy.en
}
