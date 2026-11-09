import { useI18n } from '@/i18n'

/**
 * The words the Slack-style Team Space layout adds. Desktop only; the phone exports do not read this table.
 */
export interface TeamSpaceLayoutCopy {
  addCompany: string
  addTeammates: string
  inviteMembers: string
  addChannel: string
  creationStep: (position: string) => string
  logoTitle: string
  logoBody: string
  chooseLogo: string
  replaceLogo: string
  logoFailed: string
  companyLogo: string
  saveLogo: string
  logoSaved: string
  logoUploadFailed: string
  descriptionTitle: string
  descriptionBody: string
  descriptionPlaceholder: string
  inviteTitle: string
  inviteBody: string
  invitePlaceholder: string
  joinWithInviteLink: string
  joinInviteTitle: string
  inviteLinkLabel: string
  inviteLinkHint: string
  previewInvite: string
  previewingInvite: string
  invitedTo: (company: string) => string
  inviteFrom: (inviter: string) => string
  inviteExpires: (when: string) => string
  joinInvite: string
  joiningInvite: string
  invalidInviteLink: string
  expiredInviteLink: string
  revokedInviteLink: string
  exhaustedInviteLink: string
  alreadyMemberInvite: string
  wrongAccountInvite: string
  inviteJoined: string
  inviteUnavailable: string
  back: string
  next: string
  skip: string
  finish: string
  formatting: string
  bold: string
  italic: string
  strike: string
  link: string
  bulletList: string
  numberedList: string
  code: string
  codeBlock: string
  lastReply: (when: string) => string
}

const copy: Record<string, TeamSpaceLayoutCopy> = {
  en: {
    addCompany: 'Add company',
    addTeammates: 'Invite teammates',
    inviteMembers: 'Invite members',
    addChannel: 'Add channel',
    creationStep: position => `Step ${position}`,
    logoTitle: 'Add a company logo',
    logoBody: 'Optional. Choose a square image, or skip this step.',
    chooseLogo: 'Choose image',
    replaceLogo: 'Choose another',
    logoFailed: 'That image could not be prepared. Choose another one.',
    companyLogo: 'Company logo',
    saveLogo: 'Save logo',
    logoSaved: 'Logo saved.',
    logoUploadFailed: 'The logo could not be uploaded. Try again.',
    descriptionTitle: 'Describe the company',
    descriptionBody: 'Optional. One line is enough.',
    descriptionPlaceholder: 'What does this company do?',
    inviteTitle: 'Invite members',
    inviteBody: 'Optional. Enter usernames separated by commas.',
    invitePlaceholder: '@lan, @minh',
    joinWithInviteLink: 'Join with invite link',
    joinInviteTitle: 'Join a company',
    inviteLinkLabel: 'Invite link',
    inviteLinkHint: 'Paste the full HTTPS invite link.',
    previewInvite: 'Preview invite',
    previewingInvite: 'Checking invite…',
    invitedTo: company => `You’re invited to ${company}.`,
    inviteFrom: inviter => `Invited by ${inviter}.`,
    inviteExpires: when => `Expires ${when}.`,
    joinInvite: 'Join',
    joiningInvite: 'Joining…',
    invalidInviteLink: 'This invite link is not valid.',
    expiredInviteLink: 'This invite link has expired.',
    revokedInviteLink: 'This invite link was revoked.',
    exhaustedInviteLink: 'This invite link has no uses left.',
    alreadyMemberInvite: 'You are already a member. Opening the company…',
    wrongAccountInvite: 'This invite was previewed with another account.',
    inviteJoined: 'Joined. Opening the company…',
    inviteUnavailable: 'The invite could not be checked. Try again.',
    back: 'Back',
    next: 'Next',
    skip: 'Skip',
    finish: 'Create company',
    formatting: 'Formatting',
    bold: 'Bold',
    italic: 'Italic',
    strike: 'Strikethrough',
    link: 'Link',
    bulletList: 'Bulleted list',
    numberedList: 'Numbered list',
    code: 'Code',
    codeBlock: 'Code block',
    lastReply: when => `Last reply ${when}`
  },
  vi: {
    addCompany: 'Thêm công ty',
    addTeammates: 'Mời đồng nghiệp',
    inviteMembers: 'Mời thành viên',
    addChannel: 'Thêm kênh',
    creationStep: position => `Bước ${position}`,
    logoTitle: 'Thêm logo công ty',
    logoBody: 'Không bắt buộc. Chọn ảnh vuông hoặc bỏ qua bước này.',
    chooseLogo: 'Chọn ảnh',
    replaceLogo: 'Chọn ảnh khác',
    logoFailed: 'Không chuẩn bị được ảnh này. Hãy chọn ảnh khác.',
    companyLogo: 'Logo công ty',
    saveLogo: 'Lưu logo',
    logoSaved: 'Đã lưu logo.',
    logoUploadFailed: 'Không tải được logo lên. Hãy thử lại.',
    descriptionTitle: 'Mô tả công ty',
    descriptionBody: 'Không bắt buộc. Chỉ cần một dòng.',
    descriptionPlaceholder: 'Công ty này làm gì?',
    inviteTitle: 'Mời thành viên',
    inviteBody: 'Không bắt buộc. Nhập tên người dùng, ngăn cách bằng dấu phẩy.',
    invitePlaceholder: '@lan, @minh',
    joinWithInviteLink: 'Tham gia bằng liên kết mời',
    joinInviteTitle: 'Tham gia công ty',
    inviteLinkLabel: 'Liên kết mời',
    inviteLinkHint: 'Dán đầy đủ liên kết mời HTTPS.',
    previewInvite: 'Xem lời mời',
    previewingInvite: 'Đang kiểm tra lời mời…',
    invitedTo: company => `Bạn được mời vào ${company}.`,
    inviteFrom: inviter => `Lời mời từ ${inviter}.`,
    inviteExpires: when => `Hết hạn ${when}.`,
    joinInvite: 'Tham gia',
    joiningInvite: 'Đang tham gia…',
    invalidInviteLink: 'Liên kết mời này không hợp lệ.',
    expiredInviteLink: 'Liên kết mời này đã hết hạn.',
    revokedInviteLink: 'Liên kết mời này đã bị thu hồi.',
    exhaustedInviteLink: 'Liên kết mời này đã hết lượt dùng.',
    alreadyMemberInvite: 'Bạn đã là thành viên. Đang mở công ty…',
    wrongAccountInvite: 'Lời mời này đã được xem bằng một tài khoản khác.',
    inviteJoined: 'Đã tham gia. Đang mở công ty…',
    inviteUnavailable: 'Không kiểm tra được lời mời. Hãy thử lại.',
    back: 'Quay lại',
    next: 'Tiếp',
    skip: 'Bỏ qua',
    finish: 'Tạo công ty',
    formatting: 'Định dạng',
    bold: 'In đậm',
    italic: 'In nghiêng',
    strike: 'Gạch ngang',
    link: 'Liên kết',
    bulletList: 'Danh sách dấu đầu dòng',
    numberedList: 'Danh sách đánh số',
    code: 'Mã',
    codeBlock: 'Khối mã',
    lastReply: when => `Trả lời cuối ${when}`
  },
  ja: {
    addCompany: '会社を追加',
    addTeammates: 'チームメイトを招待',
    inviteMembers: 'メンバーを招待',
    addChannel: 'チャンネルを追加',
    creationStep: position => `ステップ ${position}`,
    logoTitle: '会社のロゴを追加',
    logoBody: '任意です。正方形の画像を選ぶか、この手順をスキップしてください。',
    chooseLogo: '画像を選択',
    replaceLogo: '別の画像を選択',
    logoFailed: 'この画像を準備できませんでした。別の画像を選んでください。',
    companyLogo: '会社のロゴ',
    saveLogo: 'ロゴを保存',
    logoSaved: 'ロゴを保存しました。',
    logoUploadFailed: 'ロゴをアップロードできませんでした。もう一度お試しください。',
    descriptionTitle: '会社について',
    descriptionBody: '任意です。1行で十分です。',
    descriptionPlaceholder: 'この会社は何をしていますか？',
    inviteTitle: 'メンバーを招待',
    inviteBody: '任意です。ユーザー名をカンマで区切って入力してください。',
    invitePlaceholder: '@lan, @minh',
    joinWithInviteLink: '招待リンクで参加',
    joinInviteTitle: '会社に参加',
    inviteLinkLabel: '招待リンク',
    inviteLinkHint: 'HTTPS の招待リンク全体を貼り付けてください。',
    previewInvite: '招待を確認',
    previewingInvite: '招待を確認中…',
    invitedTo: company => `${company} に招待されています。`,
    inviteFrom: inviter => `${inviter} からの招待です。`,
    inviteExpires: when => `${when}に期限切れ。`,
    joinInvite: '参加',
    joiningInvite: '参加中…',
    invalidInviteLink: 'この招待リンクは無効です。',
    expiredInviteLink: 'この招待リンクは期限切れです。',
    revokedInviteLink: 'この招待リンクは取り消されました。',
    exhaustedInviteLink: 'この招待リンクは使用上限に達しました。',
    alreadyMemberInvite: 'すでにメンバーです。会社を開いています…',
    wrongAccountInvite: 'この招待は別のアカウントで確認されました。',
    inviteJoined: '参加しました。会社を開いています…',
    inviteUnavailable: '招待を確認できませんでした。もう一度お試しください。',
    back: '戻る',
    next: '次へ',
    skip: 'スキップ',
    finish: '会社を作成',
    formatting: '書式',
    bold: '太字',
    italic: '斜体',
    strike: '取り消し線',
    link: 'リンク',
    bulletList: '箇条書き',
    numberedList: '番号付きリスト',
    code: 'コード',
    codeBlock: 'コードブロック',
    lastReply: when => `最後の返信 ${when}`
  },
  zh: {
    addCompany: '添加公司',
    addTeammates: '邀请团队成员',
    inviteMembers: '邀请成员',
    addChannel: '添加频道',
    creationStep: position => `第 ${position} 步`,
    logoTitle: '添加公司标志',
    logoBody: '可选。选择一张方形图片，或跳过此步骤。',
    chooseLogo: '选择图片',
    replaceLogo: '选择其他图片',
    logoFailed: '无法处理这张图片。请选择其他图片。',
    companyLogo: '公司标志',
    saveLogo: '保存标志',
    logoSaved: '标志已保存。',
    logoUploadFailed: '无法上传标志。请重试。',
    descriptionTitle: '描述公司',
    descriptionBody: '可选。一行即可。',
    descriptionPlaceholder: '这家公司做什么？',
    inviteTitle: '邀请成员',
    inviteBody: '可选。请输入用户名，并用逗号分隔。',
    invitePlaceholder: '@lan, @minh',
    joinWithInviteLink: '使用邀请链接加入',
    joinInviteTitle: '加入公司',
    inviteLinkLabel: '邀请链接',
    inviteLinkHint: '粘贴完整的 HTTPS 邀请链接。',
    previewInvite: '查看邀请',
    previewingInvite: '正在检查邀请…',
    invitedTo: company => `你受邀加入 ${company}。`,
    inviteFrom: inviter => `邀请人：${inviter}。`,
    inviteExpires: when => `到期时间：${when}。`,
    joinInvite: '加入',
    joiningInvite: '正在加入…',
    invalidInviteLink: '此邀请链接无效。',
    expiredInviteLink: '此邀请链接已过期。',
    revokedInviteLink: '此邀请链接已撤销。',
    exhaustedInviteLink: '此邀请链接的使用次数已用完。',
    alreadyMemberInvite: '你已是成员。正在打开公司…',
    wrongAccountInvite: '此邀请已由另一个账户查看。',
    inviteJoined: '已加入。正在打开公司…',
    inviteUnavailable: '无法检查邀请。请重试。',
    back: '返回',
    next: '下一步',
    skip: '跳过',
    finish: '创建公司',
    formatting: '格式',
    bold: '粗体',
    italic: '斜体',
    strike: '删除线',
    link: '链接',
    bulletList: '项目符号列表',
    numberedList: '编号列表',
    code: '代码',
    codeBlock: '代码块',
    lastReply: when => `最后回复 ${when}`
  },
  'zh-hant': {
    addCompany: '新增公司',
    addTeammates: '邀請團隊成員',
    inviteMembers: '邀請成員',
    addChannel: '新增頻道',
    creationStep: position => `第 ${position} 步`,
    logoTitle: '新增公司標誌',
    logoBody: '選填。選擇一張方形圖片，或略過此步驟。',
    chooseLogo: '選擇圖片',
    replaceLogo: '選擇其他圖片',
    logoFailed: '無法處理這張圖片。請選擇其他圖片。',
    companyLogo: '公司標誌',
    saveLogo: '儲存標誌',
    logoSaved: '標誌已儲存。',
    logoUploadFailed: '無法上傳標誌。請再試一次。',
    descriptionTitle: '描述公司',
    descriptionBody: '選填。一行即可。',
    descriptionPlaceholder: '這家公司做什麼？',
    inviteTitle: '邀請成員',
    inviteBody: '選填。請輸入使用者名稱，並用逗號分隔。',
    invitePlaceholder: '@lan, @minh',
    joinWithInviteLink: '使用邀請連結加入',
    joinInviteTitle: '加入公司',
    inviteLinkLabel: '邀請連結',
    inviteLinkHint: '貼上完整的 HTTPS 邀請連結。',
    previewInvite: '查看邀請',
    previewingInvite: '正在檢查邀請…',
    invitedTo: company => `你受邀加入 ${company}。`,
    inviteFrom: inviter => `邀請人：${inviter}。`,
    inviteExpires: when => `到期時間：${when}。`,
    joinInvite: '加入',
    joiningInvite: '正在加入…',
    invalidInviteLink: '此邀請連結無效。',
    expiredInviteLink: '此邀請連結已過期。',
    revokedInviteLink: '此邀請連結已撤銷。',
    exhaustedInviteLink: '此邀請連結的使用次數已用完。',
    alreadyMemberInvite: '你已是成員。正在開啟公司…',
    wrongAccountInvite: '此邀請已由另一個帳戶查看。',
    inviteJoined: '已加入。正在開啟公司…',
    inviteUnavailable: '無法檢查邀請。請再試一次。',
    back: '返回',
    next: '下一步',
    skip: '略過',
    finish: '建立公司',
    formatting: '格式',
    bold: '粗體',
    italic: '斜體',
    strike: '刪除線',
    link: '連結',
    bulletList: '項目符號清單',
    numberedList: '編號清單',
    code: '程式碼',
    codeBlock: '程式碼區塊',
    lastReply: when => `最後回覆 ${when}`
  }
}

export function teamSpaceLayoutCopy(locale: string): TeamSpaceLayoutCopy {
  return Object.hasOwn(copy, locale) ? copy[locale]! : copy.en!
}

export function useTeamSpaceLayoutCopy(): TeamSpaceLayoutCopy {
  return teamSpaceLayoutCopy(useI18n().locale)
}
