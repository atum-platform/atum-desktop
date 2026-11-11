import { matrixFirstLearningStarting } from './matrix-first-learning'
import type { MatrixProgressMarker, MatrixProgressPresentation } from './matrix-progress-marker'

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

type Locale = 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant'

/** A wait on a named Mac and a Touch ID wait (agent-turns/1.5 `device_wait`, `touch_id`): the Mac is
 * the marker's `device`, by its owner-visible name; a line without one says "your Mac". */
export const matrixDeviceWaitCopy: Record<Locale, {
  yourMac: string
  waiting(name: string): string
  touchId(name: string): string
}> = {
  en: {
    yourMac: 'your Mac',
    waiting: name => `Waiting for ${name}…`,
    touchId: name => `Waiting for you to confirm with Touch ID on ${name}.`
  },
  vi: {
    yourMac: 'máy Mac của bạn',
    waiting: name => `Đang chờ ${name}…`,
    touchId: name => `Đang chờ bạn xác nhận Touch ID trên ${name}.`
  },
  ja: {
    yourMac: 'お使いの Mac',
    waiting: name => `${name} を待っています…`,
    touchId: name => `${name} で Touch ID の確認を待っています。`
  },
  zh: {
    yourMac: '你的 Mac',
    waiting: name => `正在等待 ${name}…`,
    touchId: name => `正在等待你在 ${name} 上用 Touch ID 确认。`
  },
  'zh-hant': {
    yourMac: '你的 Mac',
    waiting: name => `正在等待 ${name}…`,
    touchId: name => `正在等待你在 ${name} 上用 Touch ID 確認。`
  }
}

/** The generated line over the agent's checklist (`todo_progress`); the items stay as written. */
export const matrixTodoProgressCopy: Record<Locale, (done: number, total: number) => string> = {
  en: (done, total) => (done < total ? `${done} of ${total} done` : `All ${total} done, wrapping up…`),
  vi: (done, total) => (done < total ? `Đã xong ${done}/${total} việc` : `Đã xong cả ${total} việc, mình đang hoàn tất…`),
  ja: (done, total) => (done < total ? `${total}件中${done}件完了` : `${total}件すべて完了、仕上げています…`),
  zh: (done, total) => (done < total ? `已完成 ${done}/${total} 项` : `${total} 项都已完成，正在收尾…`),
  'zh-hant': (done, total) => (done < total ? `已完成 ${done}/${total} 項` : `${total} 項都已完成，正在收尾…`)
}

/** The line's first row in the viewer's language, from the descriptor alone. */
function presentationHeader(
  presentation: MatrixProgressPresentation,
  marker: Pick<MatrixProgressMarker, 'device'>,
  locale: Locale
): string {
  const device = marker.device ?? matrixDeviceWaitCopy[locale].yourMac

  switch (presentation.code) {
    case 'tool_activity':
      return matrixToolActivityCopy[locale][presentation.args.activity]

    case 'todo_progress':
      return matrixTodoProgressCopy[locale](presentation.args.done, presentation.args.total)

    case 'first_learning':
      return matrixFirstLearningStarting(locale)

    case 'heartbeat':
      return matrixProgressCopy[locale].heartbeat(presentation.args.elapsed_minutes)

    case 'device_wait':
      return matrixDeviceWaitCopy[locale].waiting(device)

    case 'touch_id':
      return matrixDeviceWaitCopy[locale].touchId(device)
  }
}

const STEP_ROW = /^[✓✔•◦]/u

/**
 * What one working line shows to this viewer (agent-turns/1.5): with a descriptor already checked against
 * the line's marker (`matrixProgressPresentation`), its first row
 * in the viewer's current language and the checklist rows of `body` exactly as the agent wrote them;
 * without one, `body` itself. `body` stays the canonical text (copy, export, other clients).
 */
export function matrixProgressLineText(
  body: string,
  marker: Pick<MatrixProgressMarker, 'device'> | undefined,
  presentation: MatrixProgressPresentation | undefined,
  locale: Locale
): string {
  const header = marker && presentation ? presentationHeader(presentation, marker, locale) : undefined

  if (!header) {
    return body
  }

  const steps = body.split('\n').map(row => row.trim()).filter(row => STEP_ROW.test(row))

  return [header, ...steps].join('\n')
}
