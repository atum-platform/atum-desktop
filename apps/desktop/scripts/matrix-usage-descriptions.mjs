#!/usr/bin/env node
// What macOS says when Atum, or a tool its assistant runs, first asks for something private
// (ledger FR3). macOS shows one sentence: the localized InfoPlist.strings value for the
// language it picks for the app, else the Info.plist value.
//
// Language, Vietnamese first: macOS picks the app's language from the Mac's language list,
// but Atum itself opens in Vietnamese whatever the Mac's language (shared/desktop-locale.ts).
// Many Vietnamese Macs run in English, so the Info.plist value (what an English Mac, and any
// language Atum does not localize, shows) is Vietnamese, then the same sentence in English
// on its own line. A Mac in Vietnamese, Japanese or Chinese gets its own language alone
// (vi.lproj, ja.lproj, zh_CN.lproj, zh_TW.lproj). Each sentence says what the assistant
// does with it and that it happens when the person asks (Apple HIG, "Requesting
// permission"); none says "this app needs access".
//
// Which keys: every one macOS can prompt for on Atum's behalf. Electron's own Info.plist
// declares camera, microphone, system audio and Bluetooth with developer text ("This app
// needs access to the camera"); the app opens the microphone, the Desktop, Documents and
// Downloads folders and Word; the assistant's terminal (a child of Atum, so macOS asks in
// Atum's name) can reach calendars, reminders, contacts, photos, other apps through
// AppleScript, the local network and external or network drives. A key missing for a
// protected resource means a bare prompt, or a refusal or crash. Screen recording and Full
// Disk Access have no Info.plist sentence: macOS words those itself.
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'

import { isMain } from './utils.mjs'

/** Every sentence, by Info.plist key, in each language Atum localizes for macOS. */
export const MATRIX_USAGE_DESCRIPTIONS = {
  NSMicrophoneUsageDescription: {
    vi: 'Để bạn nói chuyện với trợ lý bằng giọng nói.',
    en: 'So you can talk to your assistant by voice.',
    ja: '音声でアシスタントと話せるようにします。',
    zh_CN: '让你可以用语音和助手对话。',
    zh_TW: '讓你可以用語音和助理對話。'
  },
  NSAudioCaptureUsageDescription: {
    vi: 'Chỉ khi bạn nhờ trợ lý ghi lại âm thanh đang phát trên máy Mac.',
    en: 'Only when you ask your assistant to record sound playing on your Mac.',
    ja: 'Mac で再生中の音声の録音をアシスタントに頼んだときだけ使います。',
    zh_CN: '仅在你请助手录制 Mac 上正在播放的声音时使用。',
    zh_TW: '僅在你請助理錄製 Mac 上正在播放的聲音時使用。'
  },
  NSCameraUsageDescription: {
    vi: 'Chỉ khi bạn nhờ trợ lý chụp ảnh hoặc quay video bằng camera.',
    en: 'Only when you ask your assistant to take a photo or video with the camera.',
    ja: 'カメラでの写真やビデオの撮影をアシスタントに頼んだときだけ使います。',
    zh_CN: '仅在你请助手用相机拍照或录像时使用。',
    zh_TW: '僅在你請助理用相機拍照或錄影時使用。'
  },
  NSBluetoothAlwaysUsageDescription: {
    vi: 'Chỉ khi bạn nhờ trợ lý làm việc với một thiết bị Bluetooth.',
    en: 'Only when you ask your assistant to work with a Bluetooth device.',
    ja: 'Bluetooth 機器での作業をアシスタントに頼んだときだけ使います。',
    zh_CN: '仅在你请助手使用蓝牙设备时使用。',
    zh_TW: '僅在你請助理使用藍牙裝置時使用。'
  },
  NSBluetoothPeripheralUsageDescription: {
    vi: 'Chỉ khi bạn nhờ trợ lý làm việc với một thiết bị Bluetooth.',
    en: 'Only when you ask your assistant to work with a Bluetooth device.',
    ja: 'Bluetooth 機器での作業をアシスタントに頼んだときだけ使います。',
    zh_CN: '仅在你请助手使用蓝牙设备时使用。',
    zh_TW: '僅在你請助理使用藍牙裝置時使用。'
  },
  NSAppleEventsUsageDescription: {
    vi: 'Để trợ lý làm việc trong ứng dụng bạn chọn, như Word hay Ghi chú, khi bạn nhờ.',
    en: 'So your assistant can work in an app you choose, such as Word or Notes, when you ask.',
    ja: '頼んだときに、Word やメモなど選んだアプリでアシスタントが作業できるようにします。',
    zh_CN: '让助手在你需要时，在你选择的应用（如 Word 或备忘录）中工作。',
    zh_TW: '讓助理在你需要時，在你選擇的 App（如 Word 或備忘錄）中工作。'
  },
  NSDesktopFolderUsageDescription: {
    vi: 'Để trợ lý tìm và làm việc với các tệp trên Màn hình nền khi bạn cần.',
    en: 'So your assistant can find and work with files on your Desktop when you ask.',
    ja: 'アシスタントが必要なときにデスクトップのファイルを探して扱えるようにします。',
    zh_CN: '让助手在你需要时查找并处理桌面上的文件。',
    zh_TW: '讓助理在你需要時尋找並處理桌面上的檔案。'
  },
  NSDocumentsFolderUsageDescription: {
    vi: 'Để trợ lý tìm và làm việc với tài liệu của bạn khi bạn cần.',
    en: 'So your assistant can find and work with your documents when you ask.',
    ja: 'アシスタントが必要なときに書類を探して扱えるようにします。',
    zh_CN: '让助手在你需要时查找并处理你的文稿。',
    zh_TW: '讓助理在你需要時尋找並處理你的文件。'
  },
  NSDownloadsFolderUsageDescription: {
    vi: 'Để trợ lý tìm và làm việc với các tệp bạn đã tải về khi bạn cần.',
    en: 'So your assistant can find and work with files you downloaded when you ask.',
    ja: 'アシスタントが必要なときにダウンロードしたファイルを探して扱えるようにします。',
    zh_CN: '让助手在你需要时查找并处理你下载的文件。',
    zh_TW: '讓助理在你需要時尋找並處理你下載的檔案。'
  },
  NSRemovableVolumesUsageDescription: {
    vi: 'Để trợ lý làm việc với tệp trên ổ USB hay thẻ nhớ khi bạn nhờ.',
    en: 'So your assistant can work with files on a USB drive or memory card when you ask.',
    ja: '頼んだときに、アシスタントが USB ドライブやメモリカードのファイルを扱えるようにします。',
    zh_CN: '让助手在你需要时处理 U 盘或存储卡上的文件。',
    zh_TW: '讓助理在你需要時處理隨身碟或記憶卡上的檔案。'
  },
  NSNetworkVolumesUsageDescription: {
    vi: 'Để trợ lý làm việc với tệp trên ổ mạng khi bạn nhờ.',
    en: 'So your assistant can work with files on a network drive when you ask.',
    ja: '頼んだときに、アシスタントがネットワークドライブのファイルを扱えるようにします。',
    zh_CN: '让助手在你需要时处理网络磁盘上的文件。',
    zh_TW: '讓助理在你需要時處理網路磁碟上的檔案。'
  },
  NSCalendarsUsageDescription: {
    vi: 'Để trợ lý xem lịch và thêm hoặc sửa sự kiện khi bạn nhờ.',
    en: 'So your assistant can check your calendar and add or change events when you ask.',
    ja: '頼んだときに、アシスタントがカレンダーを確認し、予定を追加・変更できるようにします。',
    zh_CN: '让助手在你需要时查看日历并添加或修改日程。',
    zh_TW: '讓助理在你需要時查看行事曆並新增或修改活動。'
  },
  NSCalendarsFullAccessUsageDescription: {
    vi: 'Để trợ lý xem lịch và thêm hoặc sửa sự kiện khi bạn nhờ.',
    en: 'So your assistant can check your calendar and add or change events when you ask.',
    ja: '頼んだときに、アシスタントがカレンダーを確認し、予定を追加・変更できるようにします。',
    zh_CN: '让助手在你需要时查看日历并添加或修改日程。',
    zh_TW: '讓助理在你需要時查看行事曆並新增或修改活動。'
  },
  NSRemindersUsageDescription: {
    vi: 'Để trợ lý xem, thêm và đánh dấu xong lời nhắc khi bạn nhờ.',
    en: 'So your assistant can read, add and complete your reminders when you ask.',
    ja: '頼んだときに、アシスタントがリマインダーを確認・追加・完了できるようにします。',
    zh_CN: '让助手在你需要时查看、添加和完成提醒事项。',
    zh_TW: '讓助理在你需要時查看、新增和完成提醒事項。'
  },
  NSRemindersFullAccessUsageDescription: {
    vi: 'Để trợ lý xem, thêm và đánh dấu xong lời nhắc khi bạn nhờ.',
    en: 'So your assistant can read, add and complete your reminders when you ask.',
    ja: '頼んだときに、アシスタントがリマインダーを確認・追加・完了できるようにします。',
    zh_CN: '让助手在你需要时查看、添加和完成提醒事项。',
    zh_TW: '讓助理在你需要時查看、新增和完成提醒事項。'
  },
  NSContactsUsageDescription: {
    vi: 'Để trợ lý tìm người trong Danh bạ khi bạn nhờ, ví dụ để nhắn tin hay gửi email.',
    en: 'So your assistant can look someone up in your contacts when you ask, for example to message or email them.',
    ja: '頼んだときに、メッセージやメールを送るためなどにアシスタントが連絡先から人を探せるようにします。',
    zh_CN: '让助手在你需要时从通讯录中查找联系人，例如给对方发消息或邮件。',
    zh_TW: '讓助理在你需要時從聯絡人中查找對象，例如傳訊息或寄電子郵件給對方。'
  },
  NSPhotoLibraryUsageDescription: {
    vi: 'Để trợ lý tìm và dùng ảnh trong thư viện Ảnh khi bạn nhờ.',
    en: 'So your assistant can find and use pictures in your Photos library when you ask.',
    ja: '頼んだときに、アシスタントが写真ライブラリの写真を探して使えるようにします。',
    zh_CN: '让助手在你需要时查找并使用照片图库中的照片。',
    zh_TW: '讓助理在你需要時查找並使用照片圖庫中的照片。'
  },
  NSLocalNetworkUsageDescription: {
    vi: 'Để trợ lý kết nối với thiết bị trong mạng của bạn, như máy in hay máy tính khác, khi bạn nhờ.',
    en: 'So your assistant can reach devices on your network, such as a printer or another computer, when you ask.',
    ja: '頼んだときに、プリンタや別のコンピュータなどネットワーク上の機器にアシスタントが接続できるようにします。',
    zh_CN: '让助手在你需要时连接你网络中的设备，例如打印机或另一台电脑。',
    zh_TW: '讓助理在你需要時連線到你網路中的裝置，例如印表機或另一台電腦。'
  }
}

/** macOS's localization folders for the languages Atum speaks besides English. */
export const MATRIX_USAGE_LOCALES = ['vi', 'ja', 'zh_CN', 'zh_TW']

/** The Info.plist sentence: Vietnamese, then English on its own line. */
export function matrixBaseUsageDescription(key) {
  const entry = MATRIX_USAGE_DESCRIPTIONS[key]

  return `${entry.vi}\n${entry.en}`
}

const USAGE_KEY = /^NS[A-Za-z]+UsageDescription$/u
// Electron's and Xcode's placeholder wording, and anything empty.
const DEVELOPER_TEXT = /\bthis app\b|\bneeds? access\b|\bTODO\b|\blorem\b/iu

function unusable(value) {
  return typeof value !== 'string' || !value.trim() || DEVELOPER_TEXT.test(value)
}

/**
 * Closed codes for every way a permission prompt would show a missing, empty, developer or
 * not-Vietnamese-first sentence. `info` is the bundle's Info.plist as an object; `localized`
 * maps a locale ("vi", "en", …) to its InfoPlist.strings as an object (absent: none).
 */
export function matrixUsageDescriptionProblems({ info, localized = {} }) {
  const problems = []
  const add = (code, key, locale) => problems.push(locale ? `${code}:${locale}:${key}` : `${code}:${key}`)

  for (const key of Object.keys(MATRIX_USAGE_DESCRIPTIONS)) {
    const base = info?.[key]

    if (unusable(base)) {
      add('base_unusable', key)
    } else if (!base.startsWith(`${MATRIX_USAGE_DESCRIPTIONS[key].vi}\n`) || base === MATRIX_USAGE_DESCRIPTIONS[key].vi) {
      add('base_not_vietnamese_first', key)
    }

    for (const locale of MATRIX_USAGE_LOCALES) {
      if (unusable(localized[locale]?.[key])) {
        add('localized_unusable', key, locale)
      }
    }
  }

  // Whatever else declares a reason (a future Electron default, a new feature) must say one.
  for (const [key, value] of Object.entries(info ?? {})) {
    if (USAGE_KEY.test(key) && !(key in MATRIX_USAGE_DESCRIPTIONS) && unusable(value)) {
      add('undeclared_unusable', key)
    }
  }

  for (const [locale, strings] of Object.entries(localized)) {
    for (const [key, value] of Object.entries(strings ?? {})) {
      if (USAGE_KEY.test(key) && unusable(value)) {
        add('localized_unusable', key, locale)
      }
    }
  }

  return [...new Set(problems)]
}

function plistJson(run, file) {
  return JSON.parse(String(run('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })))
}

/** The Info.plist and every InfoPlist.strings of a built bundle, as data. Reads only. */
export function readMatrixUsageDescriptions(app, { run = execFileSync, readdir = readdirSync } = {}) {
  const contents = path.join(app, 'Contents')
  const resources = path.join(contents, 'Resources')
  const localized = {}

  for (const entry of readdir(resources).filter(name => name.endsWith('.lproj'))) {
    try {
      localized[entry.slice(0, -'.lproj'.length)] = plistJson(run, path.join(resources, entry, 'InfoPlist.strings'))
    } catch {
      // No InfoPlist.strings in this language: macOS uses the Info.plist sentence.
    }
  }

  return { info: plistJson(run, path.join(contents, 'Info.plist')), localized }
}

/** Refuses a packed bundle whose permission prompts would say nothing useful. */
export function assertMatrixUsageDescriptions(app, read = readMatrixUsageDescriptions) {
  const problems = matrixUsageDescriptionProblems(read(app))

  if (problems.length) {
    throw new Error(`matrix_usage_descriptions_invalid:${problems.join(',')}`)
  }
}

/** Reads an InfoPlist.strings file's `"Key" = "Value";` lines (source files, UTF-8). */
export function parseInfoPlistStrings(text) {
  return Object.fromEntries(
    [...String(text).matchAll(/^"([A-Za-z]+)"\s*=\s*"((?:[^"\\]|\\.)*)";$/gmu)].map(([, key, value]) => [
      key,
      value.replace(/\\n/gu, '\n').replace(/\\"/gu, '"').replace(/\\\\/gu, '\\')
    ])
  )
}

if (isMain(import.meta.url)) {
  const app = process.argv[2]

  if (!app || !app.endsWith('.app')) {
    console.error('Usage: node scripts/matrix-usage-descriptions.mjs "<path>/Atum Matrix Candidate.app"')
    process.exitCode = 2
  } else {
    const problems = matrixUsageDescriptionProblems(readMatrixUsageDescriptions(path.resolve(app)))

    console.log(JSON.stringify({ problems }, null, 2))
    process.exitCode = problems.length ? 1 : 0
  }
}
