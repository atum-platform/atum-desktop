interface MatrixStatusLineCopy {
  /** A turn's one status line, while it waits on the person at this Mac: typing and the read
   * receipt say it is working the rest of the time. */
  waiting: string
  /** The same line once that wait is over, however it ended: never a stale "waiting". */
  waited: string
}

/** Only fixed presentation copy: no prompt, command, secret, IDs or SDK errors. */
export const matrixStatusLineCopy: Record<'en' | 'vi' | 'ja' | 'zh' | 'zh-hant', MatrixStatusLineCopy> = {
  en: { waiting: 'Waiting for you on your Mac.', waited: 'Waited for you on your Mac.' },
  vi: { waiting: 'Đang chờ bạn trả lời trên máy Mac.', waited: 'Đã chờ bạn trả lời trên máy Mac.' },
  ja: { waiting: 'Macでの応答を待っています。', waited: 'Macでの応答を待ちました。' },
  zh: { waiting: '正在等待你在 Mac 上回复。', waited: '已等待你在 Mac 上回复。' },
  'zh-hant': { waiting: '正在等待你在 Mac 上回覆。', waited: '已等待你在 Mac 上回覆。' }
}

interface MatrixProgressCopy {
  /** The quiet heartbeat after about three minutes without new narration: elapsed work only,
   * never a tool name (agent-turns/1.3 §2). */
  heartbeat(minutes: number): string
  /** The collapsed line of agent-turns/1.3 (settled lines of older builds). */
  done: string
}

export const matrixProgressCopy: Record<'en' | 'vi' | 'ja' | 'zh' | 'zh-hant', MatrixProgressCopy> = {
  en: { heartbeat: minutes => `Still working · ${minutes} min`, done: 'Done.' },
  vi: { heartbeat: minutes => `Vẫn đang làm · ${minutes} phút`, done: 'Đã xong.' },
  ja: { heartbeat: minutes => `作業中 · ${minutes}分`, done: '完了しました。' },
  zh: { heartbeat: minutes => `仍在处理 · ${minutes} 分钟`, done: '已完成。' },
  'zh-hant': { heartbeat: minutes => `仍在處理 · ${minutes} 分鐘`, done: '已完成。' }
}

/** What a started tool is doing, by category (agent-turns/1.4 A8): fixed words chosen from the tool's
 * name alone, never its arguments or results. A tool outside these categories shows nothing. */
export type MatrixToolActivityKind = 'web' | 'read' | 'write' | 'run' | 'delegate' | 'look' | 'draw'

const TOOL_ACTIVITY: ReadonlyArray<readonly [RegExp, MatrixToolActivityKind]> = [
  [/^(web_|browser_)/, 'web'],
  [/^(read_file|search_files|session_search)$/, 'read'],
  [/^(write_file|patch)$/, 'write'],
  [/^(terminal|execute_code)$/, 'run'],
  [/^delegate_task$/, 'delegate'],
  [/^vision_analyze$/, 'look'],
  [/^image_generate$/, 'draw']
]

export function matrixToolActivityKind(name: string): MatrixToolActivityKind | undefined {
  return TOOL_ACTIVITY.find(([pattern]) => pattern.test(name))?.[1]
}

export const matrixToolActivityCopy: Record<
  'en' | 'vi' | 'ja' | 'zh' | 'zh-hant',
  Record<MatrixToolActivityKind, string>
> = {
  en: {
    web: 'Looking it up on the web…', read: 'Reading…', write: 'Editing files…', run: 'Running a task…',
    delegate: 'Getting a helper on it…', look: 'Looking at the image…', draw: 'Drawing…'
  },
  vi: {
    web: 'Đang tra cứu trên web…', read: 'Đang đọc…', write: 'Đang sửa tệp…', run: 'Đang chạy tác vụ…',
    delegate: 'Đang nhờ trợ lý phụ…', look: 'Đang xem hình…', draw: 'Đang vẽ…'
  },
  ja: {
    web: 'ウェブで調べています…', read: '読んでいます…', write: 'ファイルを編集しています…', run: '処理を実行しています…',
    delegate: 'アシスタントに頼んでいます…', look: '画像を見ています…', draw: '描いています…'
  },
  zh: {
    web: '正在网上查找…', read: '正在阅读…', write: '正在编辑文件…', run: '正在运行任务…',
    delegate: '正在请助手帮忙…', look: '正在查看图片…', draw: '正在绘制…'
  },
  'zh-hant': {
    web: '正在網路上查找…', read: '正在閱讀…', write: '正在編輯檔案…', run: '正在執行任務…',
    delegate: '正在請助手幫忙…', look: '正在查看圖片…', draw: '正在繪製…'
  }
}

/** The line for a started tool, or nothing when its category has no words. */
export function matrixToolActivity(locale: keyof typeof matrixToolActivityCopy, name: string): string | undefined {
  const kind = matrixToolActivityKind(name)

  return kind ? matrixToolActivityCopy[locale][kind] : undefined
}

/**
 * The acknowledgement an agent says when its turn starts working before it has said anything (a tool
 * began and no remark went out), so a model that goes straight to a tool call never leaves the chat
 * silent (agent-turns/1.4 "acknowledge, then keep working"). Fixed words with nothing from the turn in
 * them and no emoji; a few variants so it does not read as canned, one chosen per turn by its own
 * transaction (stable across a retry).
 */
export const matrixAcknowledgementCopy: Record<'en' | 'vi' | 'ja' | 'zh' | 'zh-hant', readonly string[]> = {
  en: ['On it, one moment.', 'Let me take a look.', 'Got it, working on it now.'],
  vi: ['Mình xem ngay nhé.', 'Để mình xử lý nhé.', 'Mình bắt tay vào làm đây, chờ chút nhé.'],
  ja: ['確認しますね。', 'すぐ取りかかります。', '少々お待ちください。'],
  zh: ['好的，我来处理。', '收到，我先看看。', '马上处理，请稍等。'],
  'zh-hant': ['好的，我來處理。', '收到，我先看看。', '馬上處理，請稍等。']
}
