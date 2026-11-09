/**
 * On-device approvals (S1 build plan §3, WS-4 `device/approvals.ts`).
 *
 * A protected operation that still asks (sudo, mass delete, Keychain, browser sessions, money-spending cloud
 * credentials; see `policy.ts` `ASKING_CAPABILITIES`) and has no standing grant asks for **one Touch ID on
 * the Mac where it runs**. The approval is produced by the Secure Enclave approval key
 * (`atum-device-key approve`), so the clicking agent that is driving the Mac cannot satisfy it (G0-SE:
 * synthetic input at the LocalAuthentication sheet yields no signature). Every such prompt is a fresh
 * presence check (the Secure Enclave reuse window stays 0, G0 F2) — but since owner decision 2026-10-20
 * (overriding "every protected action asks") one approval is then remembered for that agent + capability
 * for the rest of the task, at most 30 minutes (`approval-window.ts`), instead of one prompt per command.
 *
 * An `ApproveRecord` is single-use, 10 min (the sheet's wait, `DEVICE_APPROVAL_WAIT_MS`), and bound to the exact command hash, capability, target,
 * destination and account epoch. It is created only on the device and never travels on the wire; the
 * controller and the model can neither supply nor forge one (Astra follow-up #1/#3). While the prompt
 * is up the device is `paused`, so the GUI broker refuses actions (an agent cannot approve its own
 * action by clicking something else meanwhile).
 */
import { deviceMessageHash, deviceSignedBytes, verifyDeviceSignature } from './canonical'
import type { DeviceProtectedCapability } from './contracts'
import { DEVICE_APPROVAL_WAIT_MS } from './device-key'
import type { ApprovalKeyRef } from './grants-store'

/** The approval record the Secure Enclave approval key signs. Created only on the device. */
export interface ApproveRecord {
  readonly deviceServiceId: string
  readonly accountEpoch: number
  readonly commandHash: string
  readonly capability: DeviceProtectedCapability
  readonly target: string
  readonly destination?: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly nonce: string
}

export type ApprovalInvalidReason =
  | 'wrong_key'
  | 'wrong_command'
  | 'wrong_capability'
  | 'wrong_device'
  | 'stale_account_epoch'
  | 'expired'
  | 'used'

export type ApprovalVerdict =
  | { readonly outcome: 'valid'; readonly approvalHash: string }
  | { readonly outcome: 'invalid'; readonly reason: ApprovalInvalidReason }

export interface ApprovalContext {
  /** The hash of the command this approval must authorize. */
  readonly commandHash: string
  /** The protected capability the command needs. */
  readonly capability: DeviceProtectedCapability
  /** This device's id and current account epoch. */
  readonly deviceServiceId: string
  readonly accountEpoch: number
  /** The approval key enrolled for this device. */
  readonly approvalKey: ApprovalKeyRef
  /** Nonces already spent (one-use). */
  readonly usedNonces: ReadonlySet<string> | readonly string[]
  readonly now: number
}

const APPROVAL_WINDOW_MS = DEVICE_APPROVAL_WAIT_MS

function nonceUsed(context: ApprovalContext, nonce: string): boolean {
  return context.usedNonces instanceof Set
    ? context.usedNonces.has(nonce)
    : (context.usedNonces as readonly string[]).includes(nonce)
}

/**
 * Verify a signed `ApproveRecord` against the command it is supposed to authorize. Pure: no I/O, no
 * clock of its own — `context.now` is the clock so a test can pin it. The checks mirror the device-
 * service/1 `approval.valid_*` invariants: signature by the enrolled approval key, matching command,
 * capability, device and account epoch, unexpired, and an unused nonce.
 */
export function verifyApproval(record: ApproveRecord, kid: string, sig: string, context: ApprovalContext): ApprovalVerdict {
  if (kid !== context.approvalKey.kid || !verifyDeviceSignature('Approve', record, context.approvalKey.spki, sig)) {
    return { outcome: 'invalid', reason: 'wrong_key' }
  }

  if (record.deviceServiceId !== context.deviceServiceId) {
    return { outcome: 'invalid', reason: 'wrong_device' }
  }

  if (record.commandHash !== context.commandHash) {
    return { outcome: 'invalid', reason: 'wrong_command' }
  }

  if (record.capability !== context.capability) {
    return { outcome: 'invalid', reason: 'wrong_capability' }
  }

  if (record.accountEpoch !== context.accountEpoch) {
    return { outcome: 'invalid', reason: 'stale_account_epoch' }
  }

  if (context.now > record.expiresAt) {
    return { outcome: 'invalid', reason: 'expired' }
  }

  if (nonceUsed(context, record.nonce)) {
    return { outcome: 'invalid', reason: 'used' }
  }

  return { outcome: 'valid', approvalHash: deviceMessageHash('Approve', record) }
}

/** The result of asking the Secure Enclave approval key to sign: either a signed record or why not. */
export type ApprovalResult =
  | { readonly outcome: 'approved'; readonly record: ApproveRecord; readonly kid: string; readonly sig: string; readonly approvalHash: string }
  | { readonly outcome: 'denied'; readonly reason: 'approval_denied' | 'approval_timeout' | 'unavailable' }

/**
 * The Secure Enclave approval key, as the device's signer exposes it (WS-3b `device-key.ts`
 * `DeviceSigner.approve`): ES256 over `bytes` after a **fresh** Touch ID — or the macOS password on a
 * Mac without Touch ID (Q4) — whose sheet shows `reason`. It rejects with an error whose `code` is
 * `approval_denied`, `approval_timeout` or `approval_unavailable` when nobody approved.
 */
export interface ApprovalSigner {
  approve(bytes: Uint8Array, reason: string): Promise<{ kid: string; sig: string }>
}

/** What a standing grant made on the approval sheet's choice answers with: the command it was asked for
 * is covered by the new grant (its signature is the one Touch ID the owner gave). */
export interface StandingApproval {
  readonly outcome: 'approved'
  readonly approvalHash: string
  readonly standingGrantId: string
}

/** What the device's `approve` hook answers: a one-off approval, a new standing grant, or a denial. */
export type ApprovalAnswer = ApprovalResult | StandingApproval

/** The owner's choice on the approval sheet for a capability that can be granted for good. */
export type ApprovalChoice = 'once' | 'always' | 'deny'

/** Map a signer rejection to the approval outcome. Anything unrecognised is a denial, never consent. */
export function approvalFailure(error: unknown): 'approval_denied' | 'approval_timeout' | 'unavailable' {
  const code = (error as { code?: unknown } | null)?.code

  if (code === 'approval_timeout') {
    return 'approval_timeout'
  }

  if (code === 'approval_unavailable' || code === 'unavailable' || code === 'keys_missing') {
    return 'unavailable'
  }

  return 'approval_denied'
}

export interface ApprovalDeps {
  /** Pause/unpause the device (the GUI broker refuses while paused). */
  setPaused(paused: boolean): void
  signer: ApprovalSigner
  /** The enrolled approval key, for a local self-check of the returned signature. */
  approvalKey(): ApprovalKeyRef | null
  /** 16 random bytes, unpadded base64url (the record's one-use nonce). */
  nonce(): string
  now(): number
  deviceServiceId(): string
  accountEpoch(): number
  /** How long the record (and the sheet behind it) lives; default {@link DEVICE_APPROVAL_WAIT_MS}. */
  windowMs?: number
}

/**
 * Prompt for one protected approval. Builds the record, pauses the device, asks the Secure Enclave for
 * a user-presence signature over the record's signed bytes with a sheet naming the operation, and
 * self-verifies the result. The record is bound to this exact command and capability and expires when
 * the sheet's wait does (10 min). The device is always unpaused before this returns.
 */
export async function requestApproval(
  params: {
    commandHash: string
    capability: DeviceProtectedCapability
    target: string
    destination?: string
    reason: string
  },
  deps: ApprovalDeps
): Promise<ApprovalResult> {
  const approvalKey = deps.approvalKey()

  if (!approvalKey) {
    return { outcome: 'denied', reason: 'unavailable' }
  }

  const createdAt = deps.now()

  const record: ApproveRecord = {
    deviceServiceId: deps.deviceServiceId(),
    accountEpoch: deps.accountEpoch(),
    commandHash: params.commandHash,
    capability: params.capability,
    target: boundedTarget(params.target),
    ...(params.destination ? { destination: boundedTarget(params.destination) } : {}),
    createdAt,
    expiresAt: createdAt + (deps.windowMs ?? APPROVAL_WINDOW_MS),
    nonce: deps.nonce()
  }

  deps.setPaused(true)

  try {
    let signature: { kid: string; sig: string }

    try {
      signature = await deps.signer.approve(deviceSignedBytes('Approve', record), params.reason)
    } catch (error) {
      return { outcome: 'denied', reason: approvalFailure(error) }
    }

    const verdict = verifyApproval(record, signature.kid, signature.sig, {
      commandHash: params.commandHash,
      capability: params.capability,
      deviceServiceId: record.deviceServiceId,
      accountEpoch: record.accountEpoch,
      approvalKey,
      usedNonces: [],
      now: deps.now()
    })

    if (verdict.outcome !== 'valid') {
      return { outcome: 'denied', reason: verdict.reason === 'expired' ? 'approval_timeout' : 'approval_denied' }
    }

    return { outcome: 'approved', record, kid: signature.kid, sig: signature.sig, approvalHash: verdict.approvalHash }
  } finally {
    deps.setPaused(false)
  }
}

export interface ApprovalChoiceDeps {
  /** Whether the owner may grant this for good here (a `GRANTABLE` capability, an enrolled Mac, the
   * owner's own agent) and a native choice can be shown. When false the Touch ID is the only step. */
  readonly offersAlways: boolean
  /** The plain Touch ID approval of this one command. */
  once(): Promise<ApprovalResult>
  /** The one-tap choice: allow once, always allow this assistant, or don't. */
  choose(): Promise<ApprovalChoice>
  /** Signs a standing grant behind the single Touch ID; rejects when the owner does not give it. */
  grant(): Promise<{ readonly id: string; readonly approvalHash: string }>
  /** Pause/unpause the device (the GUI broker refuses while approval UI is up). */
  setPaused(paused: boolean): void
  log(line: string): void
}

/**
 * Answer one approval (owner decision 2026-10-20: "never see it twice"). A capability that can be
 * granted for good first offers the one-tap choice; "always" is a standing grant signed by the same
 * single Touch ID, so the command it was asked for runs under it and the owner is not asked again.
 * Everything else, and "once", is the plain Touch ID. The device is paused for the whole of the UI so
 * a GUI-driving agent cannot press its own buttons; a closed or failing choice is a refusal.
 */
export async function answerApproval(deps: ApprovalChoiceDeps): Promise<ApprovalAnswer> {
  if (!deps.offersAlways) {
    return deps.once()
  }

  let choice: ApprovalChoice = 'deny'

  deps.setPaused(true)

  try {
    choice = await deps.choose()
  } catch {
    choice = 'deny'
  } finally {
    deps.setPaused(false)
  }

  if (choice === 'deny') {
    return { outcome: 'denied', reason: 'approval_denied' }
  }

  if (choice === 'once') {
    return deps.once()
  }

  deps.setPaused(true)

  try {
    const grant = await deps.grant()
    deps.log('[Device] standing permission added from the approval sheet')

    return { outcome: 'approved', approvalHash: grant.approvalHash, standingGrantId: grant.id }
  } catch (error) {
    const reason = approvalFailure(error)
    deps.log(`[Device] standing permission not added: ${reason}`)

    return { outcome: 'denied', reason }
  } finally {
    deps.setPaused(false)
  }
}

/** The contract caps `target`/`destination` at 1024 characters; a longer command is cut with a marker
 * (the record still binds the full command through `commandHash`). */
function boundedTarget(text: string): string {
  const chars = Array.from(text)

  return chars.length <= 1024 ? text : `${chars.slice(0, 1020).join('')} …`
}

// -------------------------------------------------------------- the sheet's words

type SheetLocale = 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant'

const CAPABILITY_PHRASES: Record<SheetLocale, Record<DeviceProtectedCapability, string>> = {
  en: {
    ssh_agent: 'use your SSH agent',
    keychain: 'use your Keychain',
    browser_store: 'read your browser sessions',
    cloud_cli: 'use your cloud credentials (they can spend money)',
    persistence: 'change what starts with your Mac',
    network_new_host: 'reach a new host',
    sudo: 'run a command as administrator',
    other_agent_write: "write another agent's files",
    exec_downloaded: 'run a downloaded program',
    bulk_destructive: 'delete many files',
    gui_upload: 'upload through an app'
  },
  vi: {
    ssh_agent: 'dùng SSH agent của bạn',
    keychain: 'dùng Chuỗi khóa của bạn',
    browser_store: 'đọc phiên trình duyệt của bạn',
    cloud_cli: 'dùng thông tin đăng nhập đám mây của bạn (có thể tốn tiền)',
    persistence: 'thay đổi mục khởi động cùng máy Mac',
    network_new_host: 'truy cập một máy chủ mới',
    sudo: 'chạy lệnh với quyền quản trị',
    other_agent_write: 'ghi vào tệp của trợ lý khác',
    exec_downloaded: 'chạy một chương trình đã tải về',
    bulk_destructive: 'xóa nhiều tệp',
    gui_upload: 'tải lên qua một ứng dụng'
  },
  ja: {
    ssh_agent: 'SSHエージェントを使用',
    keychain: 'キーチェーンを使用',
    browser_store: 'ブラウザのセッションを読み取り',
    cloud_cli: 'クラウドの認証情報を使用（課金が発生する可能性）',
    persistence: 'Macの起動項目を変更',
    network_new_host: '新しいホストに接続',
    sudo: '管理者としてコマンドを実行',
    other_agent_write: '別のエージェントのファイルに書き込み',
    exec_downloaded: 'ダウンロードしたプログラムを実行',
    bulk_destructive: '多数のファイルを削除',
    gui_upload: 'アプリ経由でアップロード'
  },
  zh: {
    ssh_agent: '使用你的 SSH 代理',
    keychain: '使用你的钥匙串',
    browser_store: '读取你的浏览器会话',
    cloud_cli: '使用你的云凭据（可能产生费用）',
    persistence: '更改随 Mac 启动的项目',
    network_new_host: '访问新的主机',
    sudo: '以管理员身份运行命令',
    other_agent_write: '写入其他助理的文件',
    exec_downloaded: '运行下载的程序',
    bulk_destructive: '删除大量文件',
    gui_upload: '通过应用上传'
  },
  'zh-hant': {
    ssh_agent: '使用你的 SSH 代理',
    keychain: '使用你的鑰匙圈',
    browser_store: '讀取你的瀏覽器工作階段',
    cloud_cli: '使用你的雲端憑證（可能產生費用）',
    persistence: '更改隨 Mac 啟動的項目',
    network_new_host: '連線到新的主機',
    sudo: '以管理者身分執行指令',
    other_agent_write: '寫入其他助理的檔案',
    exec_downloaded: '執行下載的程式',
    bulk_destructive: '刪除大量檔案',
    gui_upload: '透過 App 上傳'
  }
}

const SHEET: Record<SheetLocale, { once(agent: string, phrase: string, target: string): string; always(agent: string, phrase: string): string }> = {
  en: {
    once: (agent, phrase, target) => `${agent} wants to ${phrase} to run ${target}. One approval covers this task (up to 30 min).`,
    always: (agent, phrase) => `Always allow ${agent} to ${phrase} on this Mac`
  },
  vi: {
    once: (agent, phrase, target) => `${agent} muốn ${phrase} để chạy ${target}. Xác nhận một lần cho cả tác vụ (tối đa 30 phút).`,
    always: (agent, phrase) => `Luôn cho phép ${agent} ${phrase} trên máy Mac này`
  },
  ja: {
    once: (agent, phrase, target) => `${agent} が${phrase}して ${target} を実行しようとしています。承認は一度で、このタスク全体（最大30分）に有効です。`,
    always: (agent, phrase) => `${agent} にこのMacでの「${phrase}」を常に許可`
  },
  zh: {
    once: (agent, phrase, target) => `${agent} 想${phrase}以运行 ${target}。一次批准即可覆盖本次任务（最长 30 分钟）。`,
    always: (agent, phrase) => `始终允许 ${agent} 在这台 Mac 上${phrase}`
  },
  'zh-hant': {
    once: (agent, phrase, target) => `${agent} 想${phrase}以執行 ${target}。一次核准即可涵蓋本次任務（最長 30 分鐘）。`,
    always: (agent, phrase) => `一律允許 ${agent} 在這台 Mac 上${phrase}`
  }
}

const CHOICE_WORDS: Record<SheetLocale, { once: string; always: string; deny: string }> = {
  en: { once: 'Allow once', always: 'Always allow this assistant', deny: "Don't allow" },
  vi: { once: 'Cho phép lần này', always: 'Luôn cho phép trợ lý này', deny: 'Không cho phép' },
  ja: { once: '今回のみ許可', always: 'このアシスタントを常に許可', deny: '許可しない' },
  zh: { once: '仅此一次', always: '始终允许此助理', deny: '不允许' },
  'zh-hant': { once: '僅此一次', always: '一律允許此助理', deny: '不允許' }
}

/** The three buttons of the approval choice, in the owner's language. */
export function approvalChoiceWords(locale?: string): { once: string; always: string; deny: string } {
  return CHOICE_WORDS[sheetLocale(locale)]
}

function sheetLocale(locale?: string): SheetLocale {
  const key = (locale ?? '').toLowerCase()

  if (key.startsWith('zh')) {
    return /hant|tw|hk|mo/.test(key) ? 'zh-hant' : 'zh'
  }

  return key.startsWith('en') ? 'en' : key.startsWith('ja') ? 'ja' : 'vi'
}

/**
 * The words on the Touch ID (or password) sheet: who, what capability, and the exact command, in the
 * owner's language (Vietnamese by default). The sheet is the only place the owner sees what they
 * approve, so the target is never summarised away (it is cut only past 400 characters).
 */
export function approvalReasonText(
  locale: string | undefined,
  input: { agent: string; capability: DeviceProtectedCapability; target?: string; always?: boolean }
): string {
  const key = sheetLocale(locale)
  const phrase = CAPABILITY_PHRASES[key][input.capability]

  if (input.always) {
    return SHEET[key].always(input.agent, phrase)
  }

  const target = Array.from(input.target ?? '')
  const shown = target.length > 400 ? `${target.slice(0, 397).join('')}…` : target.join('')

  return SHEET[key].once(input.agent, phrase, `“${shown}”`)
}
