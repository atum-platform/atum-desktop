import { type Locale, useI18n } from '@/i18n'

import type { AssistantNameProblem } from '../../../shared/matrix-assistant-name'

/** The assistant card's words (Vietnamese is the source). Never "Matrix", "Hermes", "bot",
 * an error code or a file size: codes live in `data-error-code` only. */
export interface AssistantCardCopy {
  menuEdit: string
  menuRename: string
  menuInfo: string
  sheetLabel(name: string): string
  done: string
  avatarBand: string
  avatarLabel(name: string): string
  titleOptional: string
  character: string
  markShape: string
  markColor: string
  resetDefault: string
  nameLabel(name: string): string
  nameField: string
  nameHelper: string
  nameLeft(left: number): string
  /** `char`: the character an `invalidChars` refusal is about, when it can be shown. */
  problems: Record<AssistantNameProblem, (name: string, char?: string) => string>
  primaryTip: string
  renamed: string
  undo: string
  saved: string
  saving: string
  undone: string
  saveFailed: string
  retry: string
  changedElsewhere(name: string): string
  offline: string
  loadFailed(name: string): string
  privacy(name: string): string
  message: string
  openApp(app: string): string
  purposeLabel(name: string): string
  purposePlaceholder: string
  personality: string
  personalityEmpty: string
  personalityPlaceholder: string
  instructions: string
  /** The small button beside an instruction field that opens the window-sized editor. */
  expandField(label: string): string
  /** The expanded editor's one line: how to save and how to put it back. */
  fieldKeys: string
  footnote: string
  pet: string
  petChoose: string
  skills: string
  skillsLabel(count: number): string
  findSkills: string
  checkIns: string
  checkInsBrief(time: string): string
  checkInsOff: string
  backgroundFollowups: string
  routines: string
  addRoutine: string
  routineEmpty: string
  routineLegacyPending: string
  /** The row's value: "3 việc", "Chưa có". */
  routineCount(count: number): string
  routineLoading: string
  routineLoadFailed(name: string): string
  routineLegacyMoving: string
  routineQuotaReached(count: number): string
  routineRowLabel(count: number): string
  routineEdit: string
  routineDialogSubtitle: string
  routineRunsOn: string
  routineCloudPlace: string
  routineThisMac: string
  routineSave: string
  routinePreparing: string
  routineDailyWords(time: string): string
  routineWeeklyWords(days: string, time: string): string
  routineMonthlyWords(day: number, time: string): string
  routineOnceWords(date: string, time: string): string
  routineIntervalWords(hours: number): string
  routineUnsupported: string
  routineReadOnly: string
  routineNextToday(time: string): string
  routineNextTomorrow(time: string): string
  routineNextDate(date: string, time: string): string
  routineNextZone(next: string, zone: string): string
  routineCloudOnly: string
  routineCloudMove: string
  routineNamePlaceholder: string
  routineHour: string
  routineMinute: string
  routineSuggestBrief: string
  routineSuggestBriefInstruction: string
  routineTitle: string
  routineInstruction: string
  routineSchedule: string
  routineAtTime: string
  routineRepeat: string
  routineComingSoon: string
  routineOnce: string
  routineDaily: string
  routineWeekly: string
  routineMonthly: string
  routineDate: string
  routineTime: string
  routineWeekdays: string
  routineMonthDay: string
  routineTimezone: string
  routineNotifications: string
  routineEnabled: string
  routineEnabledHint: string
  routinePause: string
  routineResume: string
  routineRunNow: string
  routineSaveAndRun: string
  routineRunOffline: string
  routineRunRefused: string
  routineRunFailed: string
  routineHistory: string
  routineNext(time: string): string
  routinePaused: string
  routineDelete(name: string): string
  routineDeleteShort: string
  routineDeleteBody: string
  routineConflict: string
  routineRunsEmpty: string
  routineCompleted: string
  routineStopped: string
  routineSkipped: string
  routineFailed: string
  routineWaiting: string
  /** The row an assistant that runs here shows while it is not ready (never a place). */
  setupRow: string
  setupRowWorking: string
  setupRowNotReady: string
  setUp: string
  /** "Advanced": the card's small section holding the one-time move (0.19.4 Q4). */
  deleteRow(name: string): string
  appCaption: string
  founderCaption: string
  verified: string
  photoError: string
  photoRemove: string
  copyHandle(handle: string): string
  copied: string
}

/** What kind of character a name refused (`AssistantNameCheck.char`), for the words only:
 * none shown (it draws nothing), a loose accent (on ◌), a framed letter or keycap emoji,
 * another alphabet's letter or digit, or a symbol. */
type RefusedKind = 'hidden' | 'mark' | 'emoji' | 'letter' | 'symbol'

function refusedKind(char?: string): RefusedKind {
  if (!char) {
    return 'hidden'
  }

  if (char.startsWith('\u25CC')) {
    return 'mark'
  }

  if (/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u.test(char)) {
    return 'emoji'
  }

  return /^[\p{L}\p{N}]/u.test(char) ? 'letter' : 'symbol'
}

const en: AssistantCardCopy = {
  menuEdit: 'Edit assistant…',
  menuRename: 'Rename…',
  menuInfo: 'Info',
  sheetLabel: name => `${name} info`,
  done: 'Done',
  avatarBand: 'Edit',
  avatarLabel: name => `${name}’s picture. Change picture`,
  titleOptional: 'Title (optional)',
  character: 'Character',
  markShape: 'Shape',
  markColor: 'Colour',
  resetDefault: 'Reset to default',
  nameLabel: name => `Display name, ${name}. Press to rename`,
  nameField: 'Display name',
  nameHelper: 'The name people see in chats.',
  nameLeft: left => `${left} left.`,
  problems: {
    empty: () => 'Give it a name.',
    tooLong: () => 'Names can be up to 40 characters.',
    invalidChars: (_, char) =>
      ({
        hidden: 'This name has a hidden character, or one that can’t be used. Type it again.',
        mark: `The accent “${char}” isn’t on a letter. Type it again.`,
        emoji: `“${char}” spells a letter or a number, so it can’t be in a name.`,
        letter: `“${char}” is from another alphabet. Names use Latin or Vietnamese letters, Chinese, Japanese, Korean, numbers, emoji and ' - . & ,`,
        symbol: `Names can’t use “${char}”. Use letters, numbers, emoji and ' - . & ,`
      })[refusedKind(char)],
    mixedScripts: () => 'A name can’t mix Japanese kana with Korean Hangul.',
    noLetters: () => 'A name needs at least one letter or number.',
    checkMark: () => 'A name can’t include a check mark.',
    reserved: () => 'This name belongs to an Atum assistant.',
    duplicate: name => `You already have an assistant named ${name}.`
  },
  primaryTip: 'Only your main assistant can be called Atum or Atum Bot.',
  renamed: 'Renamed',
  undo: 'Undo',
  saved: 'Saved',
  saving: 'Saving…',
  undone: 'Undone',
  saveFailed: 'Couldn’t save. Your change is still here.',
  retry: 'Try again',
  changedElsewhere: name => `${name} was just changed on another device. Showing the latest.`,
  offline: 'You’re offline. You can edit once you’re connected.',
  loadFailed: name => `Couldn’t load ${name}’s info.`,
  privacy: name => `In groups, ${name} answers only you.`,
  message: 'Message',
  openApp: app => `Open ${app}`,
  purposeLabel: name => `What does ${name} help you with?`,
  purposePlaceholder: 'e.g. handles my meetings and work email',
  personality: 'Personality',
  personalityEmpty: 'Not set',
  personalityPlaceholder: 'e.g. calm, keeps it short',
  instructions: 'Instructions',
  expandField: label => `Edit ${label} in a larger window`,
  fieldKeys: '⌘Return saves · Esc puts it back · Closing saves too',
  footnote: 'Changes apply from your next message.',
  pet: 'Pet',
  petChoose: 'Choose',
  skills: 'Skills',
  skillsLabel: count => `Skills, ${count}`,
  findSkills: 'Find more skills',
  checkIns: 'Check-ins',
  checkInsBrief: time => `Brief at ${time}`,
  checkInsOff: 'Off',
  backgroundFollowups: 'Background follow-ups',
  routines: 'Routines',
  addRoutine: 'Add routine',
  routineEmpty: 'No routines yet.',
  routineLegacyPending: 'Existing schedules are still active. Finish moving them before managing routines here.',
  routineCount: count => (count === 0 ? 'No routines' : count === 1 ? '1 routine' : `${count} routines`),
  routineLoading: 'Loading routines…',
  routineLoadFailed: name => `Couldn’t load ${name}’s routines.`,
  routineLegacyMoving: 'Moving old schedules.',
  routineQuotaReached: count => `You have ${count} routines. Delete one to add another.`,
  routineRowLabel: count => `Routines, ${count === 0 ? 'none' : count === 1 ? '1 routine' : `${count} routines`}`,
  routineEdit: 'Edit routine',
  routineDialogSubtitle: 'Your assistant does this on schedule, then messages you the result.',
  routineRunsOn: 'Runs on',
  routineCloudPlace: 'Cloud',
  routineThisMac: 'This Mac',
  routineSave: 'Save',
  routinePreparing: 'Getting ready…',
  routineDailyWords: time => `Every day at ${time}`,
  routineWeeklyWords: (days, time) => `${days} at ${time}`,
  routineMonthlyWords: (day, time) => `Monthly on day ${day} at ${time}`,
  routineOnceWords: (date, time) => `Once, ${date} ${time}`,
  routineIntervalWords: hours => `Every ${hours} ${hours === 1 ? 'hour' : 'hours'}`,
  routineUnsupported: 'Another schedule',
  routineReadOnly: 'View only',
  routineNextToday: time => `Next run: today ${time}`,
  routineNextTomorrow: time => `Next run: tomorrow ${time}`,
  routineNextDate: (date, time) => `Next run: ${date} ${time}`,
  routineNextZone: (next, zone) => `${next} (${zone})`,
  routineCloudOnly: 'Routines run only while the assistant answers in the cloud.',
  routineCloudMove: 'Move to the cloud',
  routineNamePlaceholder: 'Leave empty to use the first words',
  routineHour: 'Hour',
  routineMinute: 'Minute',
  routineSuggestBrief: 'Morning brief',
  routineSuggestBriefInstruction: 'Summarise what matters today and send it to me.',
  routineTitle: 'Name',
  routineInstruction: 'What should this assistant do?',
  routineSchedule: 'Schedule',
  routineAtTime: 'At a time',
  routineRepeat: 'Repeat',
  routineComingSoon: 'Coming soon',
  routineOnce: 'Once',
  routineDaily: 'Daily',
  routineWeekly: 'Weekly',
  routineMonthly: 'Monthly',
  routineDate: 'Date',
  routineTime: 'Time',
  routineWeekdays: 'Days',
  routineMonthDay: 'Day of month',
  routineTimezone: 'Time zone',
  routineNotifications: 'Notifications',
  routineEnabled: 'Enabled',
  routineEnabledHint: 'A turned-off routine stays saved but does not run.',
  routinePause: 'Pause',
  routineResume: 'Resume',
  routineRunNow: 'Run now',
  routineSaveAndRun: 'Save & run now',
  routineRunOffline: 'Could not reach the cloud. Try running it again.',
  routineRunRefused: 'This saved routine cannot be run.',
  routineRunFailed: 'Could not start this routine. Try again.',
  routineHistory: 'Recent runs',
  routineNext: time => `Next run: ${time}`,
  routinePaused: 'Paused',
  routineDelete: name => `Delete ${name}…`,
  routineDeleteShort: 'Delete routine',
  routineDeleteBody: 'This stops future runs. Recent results stay in the chat.',
  routineConflict: 'This routine changed on another device. Your draft is still here.',
  routineRunsEmpty: 'No runs yet.',
  routineCompleted: 'Completed',
  routineStopped: 'Stopped',
  routineSkipped: 'Skipped',
  routineFailed: 'Failed',
  routineWaiting: 'Waiting',
  setupRow: 'Status',
  setupRowWorking: 'Setting up…',
  setupRowNotReady: 'Not ready yet',
  setUp: 'Set up',
  deleteRow: name => `Delete ${name}…`,
  appCaption: 'An Atum app',
  founderCaption: 'Atum’s official account',
  verified: 'Verified',
  photoError: 'Couldn’t open this image. Try a JPEG or PNG.',
  photoRemove: 'Remove photo',
  copyHandle: handle => `Copy @${handle}`,
  copied: 'Copied'
}

const vi: AssistantCardCopy = {
  menuEdit: 'Chỉnh sửa trợ lý…',
  menuRename: 'Đổi tên…',
  menuInfo: 'Thông tin',
  sheetLabel: name => `Thông tin ${name}`,
  done: 'Xong',
  avatarBand: 'Sửa',
  avatarLabel: name => `Ảnh của ${name}. Đổi ảnh`,
  titleOptional: 'Danh xưng (không bắt buộc)',
  character: 'Dấu hiệu',
  markShape: 'Hình dạng',
  markColor: 'Màu sắc',
  resetDefault: 'Đặt lại mặc định',
  nameLabel: name => `Tên hiển thị, ${name}. Nhấn để đổi`,
  nameField: 'Tên hiển thị',
  nameHelper: 'Tên mọi người thấy trong cuộc trò chuyện.',
  nameLeft: left => `Còn ${left} ký tự.`,
  problems: {
    empty: () => 'Hãy đặt một cái tên.',
    tooLong: () => 'Tên dài tối đa 40 ký tự.',
    invalidChars: (_, char) =>
      ({
        hidden: 'Tên có ký tự ẩn hoặc không dùng được. Hãy gõ lại.',
        mark: `Dấu “${char}” không nằm trên chữ nào. Hãy gõ lại.`,
        emoji: `“${char}” là chữ hoặc số trong khung, nên không dùng được trong tên.`,
        letter: `“${char}” thuộc bảng chữ khác. Tên dùng chữ Latinh hoặc tiếng Việt, chữ Trung, Nhật, Hàn, chữ số, emoji và ' - . & ,`,
        symbol: `Tên không dùng được “${char}”. Hãy dùng chữ cái, chữ số, emoji và ' - . & ,`
      })[refusedKind(char)],
    mixedScripts: () => 'Tên không thể vừa có chữ kana Nhật vừa có chữ Hàn.',
    noLetters: () => 'Tên cần có ít nhất một chữ cái hoặc chữ số.',
    checkMark: () => 'Tên không được có dấu tích.',
    reserved: () => 'Tên này dành cho trợ lý của Atum.',
    duplicate: name => `Bạn đã có trợ lý tên ${name}.`
  },
  primaryTip: 'Chỉ trợ lý chính của bạn mới có thể tên là Atum hoặc Atum Bot.',
  renamed: 'Đã đổi tên',
  undo: 'Hoàn tác',
  saved: 'Đã lưu',
  saving: 'Đang lưu…',
  undone: 'Đã hoàn tác',
  saveFailed: 'Chưa lưu được. Thay đổi của bạn vẫn còn đây.',
  retry: 'Thử lại',
  changedElsewhere: name => `${name} vừa được sửa ở thiết bị khác. Đã tải bản mới nhất.`,
  offline: 'Đang ngoại tuyến. Có mạng là sửa được.',
  loadFailed: name => `Chưa tải được thông tin của ${name}.`,
  privacy: name => `Trong nhóm, ${name} chỉ trả lời bạn.`,
  message: 'Nhắn tin',
  openApp: app => `Mở ${app}`,
  purposeLabel: name => `${name} giúp bạn việc gì?`,
  purposePlaceholder: 'Ví dụ: lo lịch họp và email công việc',
  personality: 'Tính cách',
  personalityEmpty: 'Chưa đặt',
  personalityPlaceholder: 'Ví dụ: điềm tĩnh, nói ngắn gọn',
  instructions: 'Hướng dẫn',
  expandField: label => `Sửa ${label} trong cửa sổ lớn`,
  fieldKeys: '⌘Return để lưu · Esc để hoàn tác · Đóng cũng lưu',
  footnote: 'Thay đổi áp dụng từ tin nhắn tiếp theo.',
  pet: 'Thú cưng',
  petChoose: 'Chọn',
  skills: 'Kỹ năng',
  skillsLabel: count => `Kỹ năng, ${count}`,
  findSkills: 'Tìm thêm kỹ năng',
  checkIns: 'Hỏi thăm',
  checkInsBrief: time => `Bản tin lúc ${time}`,
  checkInsOff: 'Tắt',
  backgroundFollowups: 'Theo dõi nền',
  routines: 'Lịch tự động',
  addRoutine: 'Thêm lịch',
  routineEmpty: 'Chưa có lịch tự động.',
  routineLegacyPending: 'Lịch tự động cũ vẫn đang hoạt động. Hãy chuyển xong trước khi quản lý tại đây.',
  routineCount: count => (count === 0 ? 'Chưa có' : `${count} việc`),
  routineLoading: 'Đang tải lịch…',
  routineLoadFailed: name => `Không tải được lịch tự động của ${name}.`,
  routineLegacyMoving: 'Đang chuyển lịch cũ.',
  routineQuotaReached: count => `Đã đủ ${count} lịch. Xóa bớt một lịch để thêm mới.`,
  routineRowLabel: count => `Lịch tự động, ${count === 0 ? 'chưa có' : `${count} việc`}`,
  routineEdit: 'Sửa lịch',
  routineDialogSubtitle: 'Trợ lý tự làm việc này theo lịch, rồi nhắn kết quả cho bạn.',
  routineRunsOn: 'Chạy trên',
  routineCloudPlace: 'Đám mây',
  routineThisMac: 'Máy này',
  routineSave: 'Lưu',
  routinePreparing: 'Đang chuẩn bị…',
  routineDailyWords: time => `Hằng ngày lúc ${time}`,
  routineWeeklyWords: (days, time) => (days === 'CN' ? `Chủ nhật lúc ${time}` : `Thứ ${days} lúc ${time}`),
  routineMonthlyWords: (day, time) => `Ngày ${day} hằng tháng lúc ${time}`,
  routineOnceWords: (date, time) => `Một lần, ${date} ${time}`,
  routineIntervalWords: hours => `Mỗi ${hours} giờ`,
  routineUnsupported: 'Lịch khác',
  routineReadOnly: 'Chỉ xem',
  routineNextToday: time => `Lần tới: hôm nay ${time}`,
  routineNextTomorrow: time => `Lần tới: ngày mai ${time}`,
  routineNextDate: (date, time) => `Lần tới: ${date} ${time}`,
  routineNextZone: (next, zone) => `${next} (${zone})`,
  routineCloudOnly: 'Lịch chỉ chạy khi trợ lý trả lời trên đám mây.',
  routineCloudMove: 'Chuyển lên đám mây',
  routineNamePlaceholder: 'Để trống, lấy từ câu đầu tiên',
  routineHour: 'Giờ',
  routineMinute: 'Phút',
  routineSuggestBrief: 'Bản tin sáng',
  routineSuggestBriefInstruction: 'Tóm tắt những việc quan trọng hôm nay và gửi cho tôi.',
  routineTitle: 'Tên',
  routineInstruction: 'Trợ lý cần làm gì?',
  routineSchedule: 'Lịch chạy',
  routineAtTime: 'Vào lúc',
  routineRepeat: 'Lặp lại',
  routineComingSoon: 'Sắp có',
  routineOnce: 'Một lần',
  routineDaily: 'Hằng ngày',
  routineWeekly: 'Hằng tuần',
  routineMonthly: 'Hằng tháng',
  routineDate: 'Ngày',
  routineTime: 'Giờ',
  routineWeekdays: 'Các ngày',
  routineMonthDay: 'Ngày trong tháng',
  routineTimezone: 'Múi giờ',
  routineNotifications: 'Thông báo',
  routineEnabled: 'Đang bật',
  routineEnabledHint: 'Lịch tắt vẫn được lưu nhưng không chạy.',
  routinePause: 'Tạm dừng',
  routineResume: 'Tiếp tục',
  routineRunNow: 'Chạy ngay',
  routineSaveAndRun: 'Lưu và chạy ngay',
  routineRunOffline: 'Không kết nối được với đám mây. Hãy thử chạy lại.',
  routineRunRefused: 'Lịch đã lưu này không thể chạy.',
  routineRunFailed: 'Chưa khởi động được lịch này. Hãy thử lại.',
  routineHistory: 'Lần chạy gần đây',
  routineNext: time => `Lần tới: ${time}`,
  routinePaused: 'Đã tạm dừng',
  routineDelete: name => `Xóa ${name}…`,
  routineDeleteShort: 'Xóa lịch',
  routineDeleteBody: 'Lịch sẽ không chạy nữa. Các kết quả gần đây vẫn ở trong cuộc trò chuyện.',
  routineConflict: 'Lịch này vừa thay đổi trên thiết bị khác. Bản nháp của bạn vẫn còn đây.',
  routineRunsEmpty: 'Chưa chạy lần nào.',
  routineCompleted: 'Đã xong',
  routineStopped: 'Đã dừng',
  routineSkipped: 'Đã bỏ qua',
  routineFailed: 'Không thành công',
  routineWaiting: 'Đang chờ',
  setupRow: 'Trạng thái',
  setupRowWorking: 'Đang thiết lập…',
  setupRowNotReady: 'Chưa sẵn sàng',
  setUp: 'Thiết lập',
  deleteRow: name => `Xóa ${name}…`,
  appCaption: 'Ứng dụng của Atum',
  founderCaption: 'Tài khoản chính thức của Atum',
  verified: 'Đã xác minh',
  photoError: 'Không mở được ảnh này. Hãy thử JPEG hoặc PNG.',
  photoRemove: 'Gỡ ảnh',
  copyHandle: handle => `Sao chép @${handle}`,
  copied: 'Đã chép'
}

const ja: AssistantCardCopy = {
  menuEdit: 'アシスタントを編集…',
  menuRename: '名前を変更…',
  menuInfo: '情報',
  sheetLabel: name => `${name}の情報`,
  done: '完了',
  avatarBand: '編集',
  avatarLabel: name => `${name}の写真。写真を変更`,
  titleOptional: '肩書き（任意）',
  character: 'マーク',
  markShape: '形',
  markColor: '色',
  resetDefault: 'デフォルトに戻す',
  nameLabel: name => `表示名、${name}。押して名前を変更`,
  nameField: '表示名',
  nameHelper: '会話でみんなに表示される名前です。',
  nameLeft: left => `残り${left}文字。`,
  problems: {
    empty: () => '名前を付けてください。',
    tooLong: () => '名前は40文字までです。',
    invalidChars: (_, char) =>
      ({
        hidden: '名前に見えない文字か、使えない文字が含まれています。入力し直してください。',
        mark: `「${char}」の記号が文字に付いていません。入力し直してください。`,
        emoji: `「${char}」は文字や数字を表す絵文字なので、名前に使えません。`,
        letter: `「${char}」は別の文字体系の文字です。名前に使えるのはラテン文字（ベトナム語を含む）、漢字、かな、ハングル、数字、絵文字と ' - . & , です。`,
        symbol: `「${char}」は名前に使えません。文字、数字、絵文字と ' - . & , を使ってください。`
      })[refusedKind(char)],
    mixedScripts: () => '名前にかなとハングルを一緒に使うことはできません。',
    noLetters: () => '名前には文字か数字を1つ以上入れてください。',
    checkMark: () => '名前にチェックマークは使えません。',
    reserved: () => 'この名前はAtumのアシスタント用です。',
    duplicate: name => `${name}という名前のアシスタントがすでにいます。`
  },
  primaryTip: 'AtumまたはAtum Botと名乗れるのはメインのアシスタントだけです。',
  renamed: '名前を変更しました',
  undo: '取り消す',
  saved: '保存しました',
  saving: '保存中…',
  undone: '取り消しました',
  saveFailed: '保存できませんでした。変更はここに残っています。',
  retry: '再試行',
  changedElsewhere: name => `${name}がほかのデバイスで変更されました。最新の内容を表示しています。`,
  offline: 'オフラインです。接続すると編集できます。',
  loadFailed: name => `${name}の情報を読み込めませんでした。`,
  privacy: name => `グループでは、${name}はあなたにだけ返信します。`,
  message: 'メッセージ',
  openApp: app => `${app}を開く`,
  purposeLabel: name => `${name}は何を手伝いますか？`,
  purposePlaceholder: '例：会議と仕事のメールを担当',
  personality: '性格',
  personalityEmpty: '未設定',
  personalityPlaceholder: '例：落ち着いていて、簡潔',
  instructions: '指示',
  expandField: label => `「${label}」を大きなウィンドウで編集`,
  fieldKeys: '⌘Return で保存 · Esc で元に戻す · 閉じても保存',
  footnote: '変更は次のメッセージから適用されます。',
  pet: 'ペット',
  petChoose: '選ぶ',
  skills: 'スキル',
  skillsLabel: count => `スキル、${count}`,
  findSkills: 'スキルをさらに探す',
  checkIns: 'チェックイン',
  checkInsBrief: time => `${time}にブリーフ`,
  checkInsOff: 'オフ',
  backgroundFollowups: 'バックグラウンドのフォローアップ',
  routines: 'ルーティン',
  addRoutine: 'ルーティンを追加',
  routineEmpty: 'ルーティンはまだありません。',
  routineLegacyPending: '既存のスケジュールがまだ有効です。移行を終えてからここで管理してください。',
  routineCount: count => (count === 0 ? 'まだありません' : `${count}件`),
  routineLoading: 'ルーティンを読み込み中…',
  routineLoadFailed: name => `${name}のルーティンを読み込めませんでした。`,
  routineLegacyMoving: '古いスケジュールを移行中です。',
  routineQuotaReached: count => `${count}件の上限に達しました。1件削除すると追加できます。`,
  routineRowLabel: count => `ルーティン、${count === 0 ? 'なし' : `${count}件`}`,
  routineEdit: 'ルーティンを編集',
  routineDialogSubtitle: 'アシスタントがこの作業をスケジュールどおりに行い、結果をメッセージで知らせます。',
  routineRunsOn: '実行する場所',
  routineCloudPlace: 'クラウド',
  routineThisMac: 'このMac',
  routineSave: '保存',
  routinePreparing: '準備中…',
  routineDailyWords: time => `毎日 ${time}`,
  routineWeeklyWords: (days, time) => `${days} ${time}`,
  routineMonthlyWords: (day, time) => `毎月${day}日 ${time}`,
  routineOnceWords: (date, time) => `1回、${date} ${time}`,
  routineIntervalWords: hours => `${hours}時間ごと`,
  routineUnsupported: '別のスケジュール',
  routineReadOnly: '表示のみ',
  routineNextToday: time => `次回：今日 ${time}`,
  routineNextTomorrow: time => `次回：明日 ${time}`,
  routineNextDate: (date, time) => `次回：${date} ${time}`,
  routineNextZone: (next, zone) => `${next}（${zone}）`,
  routineCloudOnly: 'ルーティンはアシスタントがクラウドで応答している間だけ実行されます。',
  routineCloudMove: 'クラウドに移動',
  routineNamePlaceholder: '空欄なら最初の数語を使います',
  routineHour: '時',
  routineMinute: '分',
  routineSuggestBrief: '朝のブリーフ',
  routineSuggestBriefInstruction: '今日の重要なことをまとめて送ってください。',
  routineTitle: '名前',
  routineInstruction: 'このアシスタントに何をさせますか？',
  routineSchedule: 'スケジュール',
  routineAtTime: '日時を指定',
  routineRepeat: '繰り返し',
  routineComingSoon: '準備中',
  routineOnce: '1回',
  routineDaily: '毎日',
  routineWeekly: '毎週',
  routineMonthly: '毎月',
  routineDate: '日付',
  routineTime: '時刻',
  routineWeekdays: '曜日',
  routineMonthDay: '日にち',
  routineTimezone: 'タイムゾーン',
  routineNotifications: '通知',
  routineEnabled: '有効',
  routineEnabledHint: 'オフのルーティンは保存されたままで、実行されません。',
  routinePause: '一時停止',
  routineResume: '再開',
  routineRunNow: '今すぐ実行',
  routineSaveAndRun: '保存して今すぐ実行',
  routineRunOffline: 'クラウドに接続できません。もう一度実行してください。',
  routineRunRefused: '保存済みのこのルーティンは実行できません。',
  routineRunFailed: 'このルーティンを開始できませんでした。もう一度お試しください。',
  routineHistory: '最近の実行',
  routineNext: time => `次回：${time}`,
  routinePaused: '一時停止中',
  routineDelete: name => `${name}を削除…`,
  routineDeleteShort: 'ルーティンを削除',
  routineDeleteBody: '今後の実行を停止します。最近の結果はチャットに残ります。',
  routineConflict: 'このルーティンは別のデバイスで変更されました。下書きはここに残っています。',
  routineRunsEmpty: '実行履歴はまだありません。',
  routineCompleted: '完了',
  routineStopped: '停止',
  routineSkipped: 'スキップ',
  routineFailed: '失敗',
  routineWaiting: '待機中',
  setupRow: '状態',
  setupRowWorking: '設定中…',
  setupRowNotReady: 'まだ準備できていません',
  setUp: '設定',
  deleteRow: name => `${name}を削除…`,
  appCaption: 'Atumのアプリ',
  founderCaption: 'Atumの公式アカウント',
  verified: '確認済み',
  photoError: 'この画像を開けませんでした。JPEGかPNGをお試しください。',
  photoRemove: '写真を削除',
  copyHandle: handle => `@${handle}をコピー`,
  copied: 'コピーしました'
}

const zh: AssistantCardCopy = {
  menuEdit: '编辑助手…',
  menuRename: '重命名…',
  menuInfo: '信息',
  sheetLabel: name => `${name} 的信息`,
  done: '完成',
  avatarBand: '编辑',
  avatarLabel: name => `${name} 的照片。更换照片`,
  titleOptional: '称号（可选）',
  character: '标记',
  markShape: '形状',
  markColor: '颜色',
  resetDefault: '恢复默认',
  nameLabel: name => `显示名称，${name}。按下以重命名`,
  nameField: '显示名称',
  nameHelper: '大家在对话中看到的名字。',
  nameLeft: left => `还剩 ${left} 个字。`,
  problems: {
    empty: () => '请起个名字。',
    tooLong: () => '名字最多 40 个字。',
    invalidChars: (_, char) =>
      ({
        hidden: '名字里有看不见或不能使用的字符。请重新输入。',
        mark: `符号“${char}”没有加在字母上。请重新输入。`,
        emoji: `“${char}”代表字母或数字，不能用在名字里。`,
        letter: `“${char}”来自其他字母体系。名字可以用拉丁字母（含越南语）、汉字、日文假名、韩文、数字、表情符号和 ' - . & ,`,
        symbol: `名字里不能用“${char}”。请用字母、数字、表情符号和 ' - . & ,`
      })[refusedKind(char)],
    mixedScripts: () => '名字不能同时使用日文假名和韩文。',
    noLetters: () => '名字至少要有一个字母或数字。',
    checkMark: () => '名字里不能有勾号。',
    reserved: () => '这个名字属于 Atum 的助手。',
    duplicate: name => `你已经有一个叫 ${name} 的助手。`
  },
  primaryTip: '只有你的主助手可以叫 Atum 或 Atum Bot。',
  renamed: '已重命名',
  undo: '撤销',
  saved: '已保存',
  saving: '正在保存…',
  undone: '已撤销',
  saveFailed: '无法保存。你的更改仍在这里。',
  retry: '重试',
  changedElsewhere: name => `${name} 刚在另一台设备上被修改。已显示最新内容。`,
  offline: '你处于离线状态。联网后即可编辑。',
  loadFailed: name => `无法加载 ${name} 的信息。`,
  privacy: name => `在群组中，${name} 只回复你。`,
  message: '发消息',
  openApp: app => `打开 ${app}`,
  purposeLabel: name => `${name} 帮你做什么？`,
  purposePlaceholder: '例如：处理我的会议和工作邮件',
  personality: '性格',
  personalityEmpty: '未设置',
  personalityPlaceholder: '例如：冷静，说话简短',
  instructions: '说明',
  expandField: label => `在更大的窗口中编辑“${label}”`,
  fieldKeys: '⌘Return 保存 · Esc 撤回 · 关闭也会保存',
  footnote: '更改将从下一条消息开始生效。',
  pet: '宠物',
  petChoose: '选择',
  skills: '技能',
  skillsLabel: count => `技能，${count}`,
  findSkills: '查找更多技能',
  checkIns: '问候',
  checkInsBrief: time => `${time} 简报`,
  checkInsOff: '关闭',
  backgroundFollowups: '后台跟进',
  routines: '定时任务',
  addRoutine: '添加定时任务',
  routineEmpty: '还没有定时任务。',
  routineLegacyPending: '现有计划仍在运行。请先完成迁移，再在这里管理。',
  routineCount: count => (count === 0 ? '还没有' : `${count} 项`),
  routineLoading: '正在加载计划…',
  routineLoadFailed: name => `无法加载${name}的计划。`,
  routineLegacyMoving: '正在迁移旧计划。',
  routineQuotaReached: count => `已有 ${count} 项计划。删除一项后才能添加。`,
  routineRowLabel: count => `自动计划，${count === 0 ? '还没有' : `${count} 项`}`,
  routineEdit: '编辑计划',
  routineDialogSubtitle: '助手会按计划完成这件事，然后把结果发给你。',
  routineRunsOn: '运行于',
  routineCloudPlace: '云端',
  routineThisMac: '这台 Mac',
  routineSave: '保存',
  routinePreparing: '正在准备…',
  routineDailyWords: time => `每天 ${time}`,
  routineWeeklyWords: (days, time) => `${days} ${time}`,
  routineMonthlyWords: (day, time) => `每月 ${day} 日 ${time}`,
  routineOnceWords: (date, time) => `一次，${date} ${time}`,
  routineIntervalWords: hours => `每 ${hours} 小时`,
  routineUnsupported: '其他计划',
  routineReadOnly: '仅供参考',
  routineNextToday: time => `下次：今天 ${time}`,
  routineNextTomorrow: time => `下次：明天 ${time}`,
  routineNextDate: (date, time) => `下次：${date} ${time}`,
  routineNextZone: (next, zone) => `${next}（${zone}）`,
  routineCloudOnly: '仅当助手在云端回答时，定时任务才会运行。',
  routineCloudMove: '移到云端',
  routineNamePlaceholder: '留空则使用开头几个词',
  routineHour: '时',
  routineMinute: '分',
  routineSuggestBrief: '早间简报',
  routineSuggestBriefInstruction: '总结今天的重要事项并发给我。',
  routineTitle: '名称',
  routineInstruction: '让这个助手做什么？',
  routineSchedule: '计划',
  routineAtTime: '指定时间',
  routineRepeat: '重复',
  routineComingSoon: '即将推出',
  routineOnce: '一次',
  routineDaily: '每天',
  routineWeekly: '每周',
  routineMonthly: '每月',
  routineDate: '日期',
  routineTime: '时间',
  routineWeekdays: '日期',
  routineMonthDay: '每月几号',
  routineTimezone: '时区',
  routineNotifications: '通知',
  routineEnabled: '已启用',
  routineEnabledHint: '关闭的定时任务仍会保存，但不会运行。',
  routinePause: '暂停',
  routineResume: '继续',
  routineRunNow: '立即运行',
  routineSaveAndRun: '保存并立即运行',
  routineRunOffline: '无法连接云端。请再次运行。',
  routineRunRefused: '无法运行这个已保存的定时任务。',
  routineRunFailed: '无法启动这个定时任务。请重试。',
  routineHistory: '最近运行',
  routineNext: time => `下次运行：${time}`,
  routinePaused: '已暂停',
  routineDelete: name => `删除 ${name}…`,
  routineDeleteShort: '删除定时任务',
  routineDeleteBody: '这会停止以后的运行。最近的结果仍保留在聊天中。',
  routineConflict: '此定时任务刚在另一台设备上更改。你的草稿仍保留在这里。',
  routineRunsEmpty: '还没有运行记录。',
  routineCompleted: '已完成',
  routineStopped: '已停止',
  routineSkipped: '已跳过',
  routineFailed: '失败',
  routineWaiting: '等待中',
  setupRow: '状态',
  setupRowWorking: '正在设置…',
  setupRowNotReady: '还没准备好',
  setUp: '设置',
  deleteRow: name => `删除 ${name}…`,
  appCaption: 'Atum 应用',
  founderCaption: 'Atum 官方账号',
  verified: '已验证',
  photoError: '无法打开这张图片。请试试 JPEG 或 PNG。',
  photoRemove: '移除照片',
  copyHandle: handle => `复制 @${handle}`,
  copied: '已复制'
}

const zhHant: AssistantCardCopy = {
  ...zh,
  menuEdit: '編輯助理…',
  menuRename: '重新命名…',
  menuInfo: '資訊',
  sheetLabel: name => `${name} 的資訊`,
  avatarBand: '編輯',
  avatarLabel: name => `${name} 的照片。更換照片`,
  titleOptional: '稱號（選填）',
  character: '標記',
  markShape: '形狀',
  markColor: '顏色',
  resetDefault: '回復預設',
  nameLabel: name => `顯示名稱，${name}。按下以重新命名`,
  nameField: '顯示名稱',
  nameHelper: '大家在對話中看到的名字。',
  nameLeft: left => `還剩 ${left} 個字。`,
  problems: {
    empty: () => '請取個名字。',
    tooLong: () => '名字最多 40 個字。',
    invalidChars: (_, char) =>
      ({
        hidden: '名字裡有看不見或不能使用的字元。請重新輸入。',
        mark: `符號「${char}」沒有加在字母上。請重新輸入。`,
        emoji: `「${char}」代表字母或數字，不能用在名字裡。`,
        letter: `「${char}」來自其他字母系統。名字可以用拉丁字母（含越南語）、漢字、日文假名、韓文、數字、表情符號和 ' - . & ,`,
        symbol: `名字裡不能用「${char}」。請用字母、數字、表情符號和 ' - . & ,`
      })[refusedKind(char)],
    mixedScripts: () => '名字不能同時使用日文假名和韓文。',
    noLetters: () => '名字至少要有一個字母或數字。',
    checkMark: () => '名字裡不能有勾號。',
    reserved: () => '這個名字屬於 Atum 的助理。',
    duplicate: name => `你已經有一個叫 ${name} 的助理。`
  },
  primaryTip: '只有你的主助理可以叫 Atum 或 Atum Bot。',
  renamed: '已重新命名',
  undo: '復原',
  saved: '已儲存',
  saving: '正在儲存…',
  undone: '已復原',
  saveFailed: '無法儲存。你的變更仍在這裡。',
  retry: '再試一次',
  changedElsewhere: name => `${name} 剛在另一台裝置上被修改。已顯示最新內容。`,
  offline: '你目前離線。連線後即可編輯。',
  loadFailed: name => `無法載入 ${name} 的資訊。`,
  privacy: name => `在群組中，${name} 只回覆你。`,
  message: '傳訊息',
  openApp: app => `開啟 ${app}`,
  purposeLabel: name => `${name} 幫你做什麼？`,
  purposePlaceholder: '例如：處理我的會議和工作郵件',
  personality: '個性',
  personalityEmpty: '未設定',
  personalityPlaceholder: '例如：冷靜，說話簡短',
  instructions: '說明',
  expandField: label => `在更大的視窗中編輯「${label}」`,
  fieldKeys: '⌘Return 儲存 · Esc 復原 · 關閉也會儲存',
  footnote: '變更將從下一則訊息開始生效。',
  pet: '寵物',
  petChoose: '選擇',
  skills: '技能',
  skillsLabel: count => `技能，${count}`,
  findSkills: '尋找更多技能',
  checkIns: '問候',
  checkInsBrief: time => `${time} 簡報`,
  checkInsOff: '關閉',
  backgroundFollowups: '背景追蹤',
  routines: '排程任務',
  addRoutine: '新增排程任務',
  routineEmpty: '還沒有排程任務。',
  routineLegacyPending: '現有排程仍在執行。請先完成移轉，再在這裡管理。',
  routineCount: count => (count === 0 ? '還沒有' : `${count} 項`),
  routineLoading: '正在載入排程…',
  routineLoadFailed: name => `無法載入${name}的排程。`,
  routineLegacyMoving: '正在移轉舊排程。',
  routineQuotaReached: count => `已有 ${count} 項排程。刪除一項後才能新增。`,
  routineRowLabel: count => `自動排程，${count === 0 ? '還沒有' : `${count} 項`}`,
  routineEdit: '編輯排程',
  routineDialogSubtitle: '助理會按排程完成這件事，然後把結果傳給你。',
  routineRunsOn: '執行於',
  routineCloudPlace: '雲端',
  routineThisMac: '這台 Mac',
  routineSave: '儲存',
  routinePreparing: '正在準備…',
  routineDailyWords: time => `每天 ${time}`,
  routineWeeklyWords: (days, time) => `${days} ${time}`,
  routineMonthlyWords: (day, time) => `每月 ${day} 日 ${time}`,
  routineOnceWords: (date, time) => `一次，${date} ${time}`,
  routineIntervalWords: hours => `每 ${hours} 小時`,
  routineUnsupported: '其他排程',
  routineReadOnly: '僅供查看',
  routineNextToday: time => `下次：今天 ${time}`,
  routineNextTomorrow: time => `下次：明天 ${time}`,
  routineNextDate: (date, time) => `下次：${date} ${time}`,
  routineNextZone: (next, zone) => `${next}（${zone}）`,
  routineCloudOnly: '僅當助手在雲端回答時，排程任務才會執行。',
  routineCloudMove: '移到雲端',
  routineNamePlaceholder: '留空則使用開頭幾個詞',
  routineHour: '時',
  routineMinute: '分',
  routineSuggestBrief: '早晨簡報',
  routineSuggestBriefInstruction: '總結今天的重要事項並傳送給我。',
  routineTitle: '名稱',
  routineInstruction: '要這個助理做什麼？',
  routineSchedule: '排程',
  routineAtTime: '指定時間',
  routineRepeat: '重複',
  routineComingSoon: '即將推出',
  routineOnce: '一次',
  routineDaily: '每天',
  routineWeekly: '每週',
  routineMonthly: '每月',
  routineDate: '日期',
  routineTime: '時間',
  routineWeekdays: '日期',
  routineMonthDay: '每月幾號',
  routineTimezone: '時區',
  routineNotifications: '通知',
  routineEnabled: '已啟用',
  routineEnabledHint: '關閉的排程任務仍會儲存，但不會執行。',
  routinePause: '暫停',
  routineResume: '繼續',
  routineRunNow: '立即執行',
  routineSaveAndRun: '儲存並立即執行',
  routineRunOffline: '無法連接雲端。請再次執行。',
  routineRunRefused: '無法執行這個已儲存的排程任務。',
  routineRunFailed: '無法啟動這個排程任務。請重試。',
  routineHistory: '最近執行',
  routineNext: time => `下次執行：${time}`,
  routinePaused: '已暫停',
  routineDelete: name => `刪除 ${name}…`,
  routineDeleteShort: '刪除排程任務',
  routineDeleteBody: '這會停止之後的執行。最近的結果仍會留在聊天中。',
  routineConflict: '這個排程任務剛在另一台裝置上變更。你的草稿仍保留在這裡。',
  routineRunsEmpty: '還沒有執行記錄。',
  routineCompleted: '已完成',
  routineStopped: '已停止',
  routineSkipped: '已略過',
  routineFailed: '失敗',
  routineWaiting: '等待中',
  setupRow: '狀態',
  setupRowWorking: '正在設定…',
  setupRowNotReady: '還沒準備好',
  setUp: '設定',
  deleteRow: name => `刪除 ${name}…`,
  appCaption: 'Atum 應用程式',
  founderCaption: 'Atum 官方帳號',
  verified: '已驗證',
  photoError: '無法開啟這張圖片。請試試 JPEG 或 PNG。',
  photoRemove: '移除照片',
  copyHandle: handle => `複製 @${handle}`,
  copied: '已複製'
}

export const assistantCardCopies: Record<Locale, AssistantCardCopy> = { en, vi, ja, zh, 'zh-hant': zhHant }

export function useAssistantCardCopy(): AssistantCardCopy {
  return assistantCardCopies[useI18n().locale]
}
