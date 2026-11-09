/**
 * The device-side view of a signed MigrationReport.
 *
 * Signature and envelope/schema validation happen at the transport boundary. This module binds
 * that accepted report to the migration this Mac started, derives the choices which the protocol
 * permits, and produces the complete native-confirmation copy. It deliberately never copies an
 * archive or the reconcile report: the report is already bounded by the frozen protocol.
 */
import { createHash } from 'node:crypto'

import { DEVICE_SERVICE_PACK } from '../../../../../packages/device-protocol/contract-packs'
import type { MigrationArchive, MigrationChoose, MigrationReport } from '../../../../../packages/device-protocol/migration-messages'

import { canonicalJson } from './canonical'

const LIMITS = DEVICE_SERVICE_PACK.parameters as Readonly<{ migration_commit_ms: number; skew_ms: number }>

export type MigrationReportLocale = 'vi' | 'en' | 'zh' | 'zh-hant' | 'ja'

/** The local facts that a controller report must bind to after its signature has been verified. */
export interface MigrationReportContext {
  migrationId: string
  agentPrincipal: string
  /** The device service for this initiating Mac. */
  deviceServiceId: string
  /** The exact archive this Mac offered; the archive bytes are never retained here. */
  archive: Readonly<Pick<MigrationArchive, 'sha256' | 'bytes' | 'files'>>
  /** The later-or-equal hold persisted by MigrationWriterHolds. */
  holdUntil: number
  /** Controller-time estimate supplied by the transport owner. Defaults to Date.now(). */
  now?: number
}

export interface MigrationChoice {
  drop: readonly string[]
  takeOther: readonly string[]
}

export interface MigrationReportChoices {
  /** The protocol's default: keep every one-sided path and this Mac's replacement. */
  defaultChoice: Readonly<MigrationChoice>
  /** Paths that can be dropped. */
  drop: readonly string[]
  /** Replaced paths for which the other Mac's bytes can replace this Mac's bytes. */
  takeOther: readonly string[]
}

export interface MigrationReportModel {
  report: MigrationReport
  choices: MigrationReportChoices
}

export type MigrationReportRejection =
  | 'migration_mismatch'
  | 'agent_mismatch'
  | 'initiator_snapshot_missing'
  | 'initiator_snapshot_altered'
  | 'report_sha256_mismatch'
  | 'report_snapshots_mismatch'
  | 'report_expired'
  | 'report_issued_in_future'
  | 'report_hold_later_than_local'
  | 'report_expiry_past_hold'

export type MigrationReportInspection =
  | { accepted: true; model: MigrationReportModel }
  | { accepted: false; reason: MigrationReportRejection }

export type MigrationChoiceRejection = 'duplicate_drop' | 'duplicate_take_other' | 'invalid_drop' | 'invalid_take_other'
export type MigrationChoiceInspection = { accepted: true } | { accepted: false; reason: MigrationChoiceRejection }

export interface MigrationReportConfirmation {
  title: string
  detail: string
  confirm: string
  customize: string
  cancel: string
}

export interface MigrationChoicePrompt {
  title: string
  detail: string
  accept: string
  keep: string
  cancel: string
}

function sameArchive(left: Pick<MigrationArchive, 'sha256' | 'bytes' | 'files'>, right: Pick<MigrationArchive, 'sha256' | 'bytes' | 'files'>): boolean {
  return left.sha256 === right.sha256 && left.bytes === right.bytes && left.files === right.files
}

function unique(items: readonly string[]): boolean {
  return new Set(items).size === items.length
}

function choiceOptions(report: MigrationReport): MigrationReportChoices {
  if (report.report === null) {
    return { defaultChoice: { drop: [], takeOther: [] }, drop: [], takeOther: [] }
  }

  const drop = [
    ...report.report.oneSided.map(entry => entry.path),
    ...report.report.skills.onlyBase.map(name => `skills/${name}`),
    ...report.report.skills.onlyOther.map(name => `skills/${name}`),
    ...report.report.skills.bothKept.map(entry => `skills/${entry.otherName}`)
  ]

  return {
    defaultChoice: { drop: [], takeOther: [] },
    drop,
    takeOther: report.report.replaced.map(entry => entry.path)
  }
}

/**
 * Accept a report only when it is for this migration and cannot outlive this Mac's persisted
 * writer hold. Call this only after the controller signature and transport envelope are valid.
 */
export function inspectMigrationReport(report: MigrationReport, context: MigrationReportContext): MigrationReportInspection {
  if (report.migrationId !== context.migrationId) {return { accepted: false, reason: 'migration_mismatch' }}

  if (report.agentPrincipal !== context.agentPrincipal) {return { accepted: false, reason: 'agent_mismatch' }}

  const initiator = report.snapshots.find(snapshot => snapshot.deviceServiceId === context.deviceServiceId)

  if (!initiator) {return { accepted: false, reason: 'initiator_snapshot_missing' }}

  if (!sameArchive(initiator, context.archive)) {return { accepted: false, reason: 'initiator_snapshot_altered' }}

  const now = context.now ?? Date.now()

  if (!Number.isSafeInteger(now) || report.issuedAt > now + LIMITS.skew_ms) {
    return { accepted: false, reason: 'report_issued_in_future' }
  }

  if (now > report.expiresAt) {return { accepted: false, reason: 'report_expired' }}

  if (report.holdUntil > context.holdUntil) {return { accepted: false, reason: 'report_hold_later_than_local' }}

  if (report.expiresAt > report.holdUntil - LIMITS.migration_commit_ms) {
    return { accepted: false, reason: 'report_expiry_past_hold' }
  }

  if (report.report === null) {
    if (report.snapshots.length !== 1 || report.reportSha256 !== null || report.snapshots[0]?.deviceServiceId !== context.deviceServiceId) {
      return { accepted: false, reason: 'report_snapshots_mismatch' }
    }
  } else {
    const [base, other] = report.snapshots

    if (report.snapshots.length !== 2 || base?.deviceServiceId !== context.deviceServiceId ||
        report.report.base !== base?.deviceServiceId || report.report.other !== other?.deviceServiceId ||
        base?.deviceServiceId === other?.deviceServiceId) {
      return { accepted: false, reason: 'report_snapshots_mismatch' }
    }

    const sha256 = createHash('sha256').update(canonicalJson(report.report), 'utf8').digest('hex')

    if (report.reportSha256 !== sha256) {return { accepted: false, reason: 'report_sha256_mismatch' }}
  }

  return { accepted: true, model: { report, choices: choiceOptions(report) } }
}

/** Validate a proposed subset before the parent builds its signed MigrationChoose frame. */
export function inspectMigrationChoice(choices: MigrationReportChoices, choice: MigrationChoice): MigrationChoiceInspection {
  if (!unique(choice.drop)) {return { accepted: false, reason: 'duplicate_drop' }}

  if (!unique(choice.takeOther)) {return { accepted: false, reason: 'duplicate_take_other' }}
  const drops = new Set(choices.drop)
  const takeOther = new Set(choices.takeOther)

  if (choice.drop.some(path => !drops.has(path))) {return { accepted: false, reason: 'invalid_drop' }}

  if (choice.takeOther.some(path => !takeOther.has(path))) {return { accepted: false, reason: 'invalid_take_other' }}

  return { accepted: true }
}

/** The only migration-choice fields this model owns; the caller adds connection and epoch binding. */
export function migrationChoiceFields(model: MigrationReportModel, choice: MigrationChoice): Pick<MigrationChoose, 'reportSha256' | 'drop' | 'takeOther'> {
  return {
    reportSha256: model.report.reportSha256,
    drop: [...choice.drop],
    takeOther: [...choice.takeOther]
  }
}

interface MigrationReportCopy {
  title: string
  confirm: string
  customize: string
  cancel: string
  selectedBase: string
  singleSnapshot: string
  replaced: string
  replacedEntry: (path: string) => string
  oneSided: string
  oneSidedEntry: (path: string, side: 'base' | 'other') => string
  skills: string
  memories: string
  sessions: (merged: boolean, added: number, skipped: number) => string
  missing: string
  missingEntry: (device: string, reason: string) => string
  omitted: (count: number) => string
}

const COPY: Record<MigrationReportLocale, MigrationReportCopy> = {
  vi: {
    title: 'Xem lại dữ liệu trước khi chuyển lên đám mây', confirm: 'Tiếp tục', customize: 'Xem lại lựa chọn', cancel: 'Hủy',
    selectedBase: 'Phiên bản trên máy Mac này được chọn mặc định. Với mỗi tệp xung đột, bạn có thể chọn phiên bản trên máy Mac kia.',
    singleSnapshot: 'Chỉ có bản chụp từ máy Mac này; phiên bản trên máy Mac này sẽ được chuyển lên đám mây.',
    replaced: 'Tệp xung đột (đang chọn phiên bản trên máy Mac này):',
    replacedEntry: path => `${path} — đang chọn máy Mac này; có thể chọn máy Mac kia.`,
    oneSided: 'Tệp chỉ có trên một máy Mac (được giữ mặc định):',
    oneSidedEntry: (path, side) => `${path} — chỉ có trên ${side === 'base' ? 'máy Mac này' : 'máy Mac kia'}.`,
    skills: 'Kỹ năng được giữ:', memories: 'Ký ức thêm từ máy Mac kia:',
    sessions: (merged, added, skipped) => `Phiên trò chuyện: ${merged ? 'đã gộp' : 'không gộp'}; thêm ${added}, bỏ qua ${skipped}.`,
    missing: 'Bản chụp không có:', missingEntry: (device, reason) => `${device} — ${reason}.`,
    omitted: count => `Mục không hiển thị trong báo cáo chi tiết: ${count}; chúng vẫn được giữ.`
  },
  en: {
    title: 'Review data before moving to the cloud', confirm: 'Continue', customize: 'Review choices', cancel: 'Cancel',
    selectedBase: 'This Mac version is selected by default. For every conflicting file, you can choose the other Mac version.',
    singleSnapshot: 'Only this Mac supplied a snapshot, so this Mac version will move to the cloud.',
    replaced: 'Conflicting files (this Mac version is selected):',
    replacedEntry: path => `${path} — this Mac selected; other Mac available.`,
    oneSided: 'Files found on one Mac only (kept by default):',
    oneSidedEntry: (path, side) => `${path} — present only on the ${side === 'base' ? 'this Mac' : 'other Mac'}.`,
    skills: 'Skills kept:', memories: 'Memories added from the other Mac:',
    sessions: (merged, added, skipped) => `Sessions: ${merged ? 'merged' : 'not merged'}; ${added} added, ${skipped} skipped.`,
    missing: 'Snapshots not available:', missingEntry: (device, reason) => `${device} — ${reason}.`,
    omitted: count => `Entries omitted from the detailed report: ${count}; they are still kept.`
  },
  zh: {
    title: '在移到云端前查看数据', confirm: '继续', customize: '查看选择', cancel: '取消',
    selectedBase: '默认选择这台 Mac 的版本。每个冲突文件都可以改选另一台 Mac 的版本。',
    singleSnapshot: '只有这台 Mac 提供了快照，因此这台 Mac 的版本将移到云端。',
    replaced: '冲突文件（已选择这台 Mac 的版本）：',
    replacedEntry: path => `${path} — 已选择这台 Mac；可选择另一台 Mac。`,
    oneSided: '仅在一台 Mac 上找到的文件（默认保留）：',
    oneSidedEntry: (path, side) => `${path} — 仅存在于${side === 'base' ? '这台 Mac' : '另一台 Mac'}。`,
    skills: '保留的技能：', memories: '从另一台 Mac 添加的记忆：',
    sessions: (merged, added, skipped) => `会话：${merged ? '已合并' : '未合并'}；新增 ${added}，跳过 ${skipped}。`,
    missing: '不可用的快照：', missingEntry: (device, reason) => `${device} — ${reason}。`,
    omitted: count => `详细报告中省略的条目：${count}；仍会保留。`
  },
  'zh-hant': {
    title: '移到雲端前檢視資料', confirm: '繼續', customize: '檢視選擇', cancel: '取消',
    selectedBase: '預設選擇這台 Mac 的版本。每個衝突檔案都可以改選另一台 Mac 的版本。',
    singleSnapshot: '只有這台 Mac 提供了快照，因此這台 Mac 的版本將移到雲端。',
    replaced: '衝突檔案（已選擇這台 Mac 的版本）：',
    replacedEntry: path => `${path} — 已選擇這台 Mac；可選擇另一台 Mac。`,
    oneSided: '僅在一台 Mac 上找到的檔案（預設保留）：',
    oneSidedEntry: (path, side) => `${path} — 僅存在於${side === 'base' ? '這台 Mac' : '另一台 Mac'}。`,
    skills: '保留的技能：', memories: '從另一台 Mac 加入的記憶：',
    sessions: (merged, added, skipped) => `工作階段：${merged ? '已合併' : '未合併'}；新增 ${added}，略過 ${skipped}。`,
    missing: '無法取得的快照：', missingEntry: (device, reason) => `${device} — ${reason}。`,
    omitted: count => `詳細報告中省略的項目：${count}；仍會保留。`
  },
  ja: {
    title: 'クラウドへ移す前にデータを確認', confirm: '続ける', customize: '選択を確認', cancel: 'キャンセル',
    selectedBase: 'この Mac の版が既定で選ばれます。競合した各ファイルでは、もう一方の Mac の版を選べます。',
    singleSnapshot: 'スナップショットを提供したのはこの Mac だけなので、この Mac の版がクラウドへ移ります。',
    replaced: '競合したファイル（この Mac の版を選択中）:',
    replacedEntry: path => `${path} — この Mac を選択中。もう一方の Mac を選べます。`,
    oneSided: '一方の Mac にだけあるファイル（既定で保持）:',
    oneSidedEntry: (path, side) => `${path} — ${side === 'base' ? 'この Mac' : 'もう一方の Mac'} にのみあります。`,
    skills: '保持するスキル:', memories: 'もう一方の Mac から追加したメモリー:',
    sessions: (merged, added, skipped) => `セッション: ${merged ? '統合済み' : '未統合'}; 追加 ${added}、スキップ ${skipped}。`,
    missing: '利用できないスナップショット:', missingEntry: (device, reason) => `${device} — ${reason}。`,
    omitted: count => `詳細レポートで省略された項目: ${count}。これらも保持されます。`
  }
}

function list(heading: string, entries: readonly string[]): string | null {
  return entries.length ? `${heading}\n${entries.map(entry => `• ${entry}`).join('\n')}` : null
}

/** Complete, untruncated text for native confirmation. Unknown locales use Vietnamese, like migrationConfirmCopy. */
export function migrationReportConfirmation(locale: string | undefined, model: MigrationReportModel): MigrationReportConfirmation {
  const copy = COPY[(Object.hasOwn(COPY, locale ?? '') ? locale : 'vi') as MigrationReportLocale]
  const report = model.report.report
  const detail: Array<string | null> = []

  if (report === null) {
    detail.push(copy.singleSnapshot)
  } else {
    detail.push(copy.selectedBase)
    detail.push(copy.sessions(report.sessions.merged, report.sessions.added, report.sessions.skipped))
    detail.push(list(copy.memories, report.memories.map(memory => `${memory.path} (+${memory.addedFromOther})`)))
    detail.push(list(copy.skills, [
      ...report.skills.onlyBase,
      ...report.skills.onlyOther,
      ...report.skills.bothKept.map(skill => `${skill.name} / ${skill.otherName}`)
    ]))
    detail.push(list(copy.oneSided, report.oneSided.map(entry => copy.oneSidedEntry(entry.path, entry.side))))
    // Replaced is intentionally listed without a cap: the frozen protocol never truncates it.
    detail.push(list(copy.replaced, report.replaced.map(entry => copy.replacedEntry(entry.path))))
    detail.push(copy.omitted(report.omitted))
  }

  detail.push(list(copy.missing, model.report.missing.map(missing => copy.missingEntry(missing.deviceServiceId, missing.reason))))

  return {
    title: copy.title,
    detail: detail.filter((section): section is string => section !== null).join('\n\n'),
    confirm: copy.confirm,
    customize: copy.customize,
    cancel: copy.cancel
  }
}

const CHOICE_COPY: Record<MigrationReportLocale, {
  drop: (path: string) => MigrationChoicePrompt
  takeOther: (path: string) => MigrationChoicePrompt
}> = {
  vi: {
    drop: path => ({
      title: `Bỏ ${path}?`,
      detail: `${path} sẽ không được đưa vào nhà trên đám mây. Chọn Giữ để giữ tệp này.`,
      accept: 'Bỏ', keep: 'Giữ', cancel: 'Hủy'
    }),
    takeOther: path => ({
      title: `Dùng phiên bản từ máy Mac kia cho ${path}?`,
      detail: `Phiên bản trên máy Mac kia sẽ thay thế phiên bản trên máy Mac này cho ${path}.`,
      accept: 'Dùng máy Mac kia', keep: 'Giữ máy Mac này', cancel: 'Hủy'
    })
  },
  en: {
    drop: path => ({
      title: `Drop ${path}?`,
      detail: `${path} will not be included in the cloud home. Choose Keep to retain this file.`,
      accept: 'Drop', keep: 'Keep', cancel: 'Cancel'
    }),
    takeOther: path => ({
      title: `Use the other Mac version of ${path}?`,
      detail: `The other Mac version will replace this Mac version for ${path}.`,
      accept: 'Use other Mac', keep: 'Keep this Mac', cancel: 'Cancel'
    })
  },
  zh: {
    drop: path => ({
      title: `删除 ${path}？`,
      detail: `${path} 不会包含在云端主目录中。选择保留以保留此文件。`,
      accept: '删除', keep: '保留', cancel: '取消'
    }),
    takeOther: path => ({
      title: `使用另一台 Mac 的 ${path} 版本？`,
      detail: `另一台 Mac 的版本将替换这台 Mac 的 ${path} 版本。`,
      accept: '使用另一台 Mac', keep: '保留这台 Mac', cancel: '取消'
    })
  },
  'zh-hant': {
    drop: path => ({
      title: `捨棄 ${path}？`,
      detail: `${path} 不會包含在雲端主目錄中。選擇保留即可保留此檔案。`,
      accept: '捨棄', keep: '保留', cancel: '取消'
    }),
    takeOther: path => ({
      title: `使用另一台 Mac 的 ${path} 版本？`,
      detail: `另一台 Mac 的版本將取代這台 Mac 的 ${path} 版本。`,
      accept: '使用另一台 Mac', keep: '保留這台 Mac', cancel: '取消'
    })
  },
  ja: {
    drop: path => ({
      title: `${path} を除外しますか？`,
      detail: `${path} はクラウドホームに含まれません。このファイルを残すには「保持」を選んでください。`,
      accept: '除外', keep: '保持', cancel: 'キャンセル'
    }),
    takeOther: path => ({
      title: `${path} にもう一方の Mac の版を使いますか？`,
      detail: `もう一方の Mac の版が、この Mac の ${path} の版を置き換えます。`,
      accept: 'もう一方の Mac を使う', keep: 'この Mac を保持', cancel: 'キャンセル'
    })
  }
}

/** A localized, path-complete choice prompt for the native review flow. */
export function migrationChoicePrompt(locale: string | undefined, kind: 'drop' | 'takeOther', path: string): MigrationChoicePrompt {
  const copy = CHOICE_COPY[(Object.hasOwn(CHOICE_COPY, locale ?? '') ? locale : 'vi') as MigrationReportLocale]

  return copy[kind](path)
}
