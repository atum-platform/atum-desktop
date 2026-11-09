import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { type Locale, useI18n } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'

import { $matrixRecoveryWriteDown } from './security-panel'
import { clearMatrixWorkbenchRecents, matrixWorkbenchRecentStorage } from './workbench-recents'

/** The confirmation, opened from the account menu or Settings; mounted once by the rail. */
export const $matrixSignOutOpen = atom(false)

interface SignOutCopy {
  title: string
  /** The account already has a recovery key: reading old messages later needs it. */
  body: string
  /** No recovery key yet: signing out now loses this Mac's copy of the old messages' keys. */
  bodyNoRecovery: string
  /** Not known yet (the account is still syncing): the same warning, without claiming either way. */
  bodyUnknown: string
  /** The key was made quietly on this Mac and never written down, and the person chose to
   * forget it here: it leaves with the sign-out. */
  bodyKeyOnMac: string
  /** This Mac keeps the key for the person (owner-keys.ts): signing in again unlocks by itself. */
  bodyKept: string
  /** Forget the kept key on this Mac too (selling or giving the Mac away). */
  forgetKey: string
  /** Forgetting leaves the key's copy in iCloud Keychain (Settings turns that off). */
  forgetKeyICloud: string
  confirm: string
  confirmAnyway: string
  setUpFirst: string
  writeDownFirst: string
  cancel: string
  failed: string
}

const copies: Record<Locale, SignOutCopy> = {
  en: {
    title: 'Sign out of Atum on this Mac?',
    body: 'You’ll need your recovery key to read past messages after signing back in.',
    bodyNoRecovery:
      'You haven’t saved a recovery key yet. Without one, past messages can’t be read after you sign back in.',
    bodyUnknown:
      'Make sure you have your recovery key before you sign out. Without it, past messages can’t be read after you sign back in.',
    bodyKeyOnMac:
      'Your recovery key is saved only on this Mac. Save it first, or you won’t be able to read past messages after signing back in.',
    bodyKept: 'Atum keeps your recovery key on this Mac, so next time you just sign in.',
    forgetKey: 'Forget the key on this Mac (if you’re selling or giving it away)',
    forgetKeyICloud:
      'The copy in iCloud Keychain stays, so signing in on this Mac again still unlocks it. To remove that copy too, turn off iCloud Keychain in Settings first.',
    confirm: 'Sign out',
    confirmAnyway: 'Sign out anyway',
    setUpFirst: 'Set up recovery key first',
    writeDownFirst: 'Save your recovery key first',
    cancel: 'Cancel',
    failed: 'Couldn’t sign out. Check your connection and try again.'
  },
  vi: {
    title: 'Đăng xuất Atum trên máy Mac này?',
    body: 'Bạn sẽ cần khóa khôi phục để đọc tin nhắn cũ sau khi đăng nhập lại.',
    bodyNoRecovery:
      'Bạn chưa lưu khóa khôi phục. Nếu không có khóa, bạn sẽ không đọc được tin nhắn cũ sau khi đăng nhập lại.',
    bodyUnknown:
      'Hãy chắc chắn bạn đã có khóa khôi phục trước khi đăng xuất. Nếu không có khóa, bạn sẽ không đọc được tin nhắn cũ sau khi đăng nhập lại.',
    bodyKeyOnMac:
      'Khóa khôi phục của bạn chỉ được lưu trên Mac này. Hãy lưu lại trước, nếu không bạn sẽ không đọc được tin nhắn cũ sau khi đăng nhập lại.',
    bodyKept: 'Atum vẫn nhớ khóa khôi phục trên Mac này, nên lần sau bạn chỉ cần đăng nhập.',
    forgetKey: 'Quên khóa trên Mac này (khi bán hoặc cho máy)',
    forgetKeyICloud:
      'Bản sao trong iCloud Keychain vẫn còn, nên đăng nhập lại trên Mac này vẫn tự mở khóa. Muốn xóa cả bản đó, hãy tắt iCloud Keychain trong Cài đặt trước.',
    confirm: 'Đăng xuất',
    confirmAnyway: 'Vẫn đăng xuất',
    setUpFirst: 'Tạo khóa khôi phục trước',
    writeDownFirst: 'Lưu khóa khôi phục trước',
    cancel: 'Hủy',
    failed: 'Chưa đăng xuất được. Kiểm tra kết nối rồi thử lại.'
  },
  ja: {
    title: 'この Mac で Atum からログアウトしますか？',
    body: 'もう一度ログインした後、過去のメッセージを読むには復旧キーが必要です。',
    bodyNoRecovery:
      'まだ復旧キーを保存していません。キーがないと、もう一度ログインした後に過去のメッセージを読めません。',
    bodyUnknown:
      'ログアウトする前に、復旧キーがあることを確認してください。キーがないと、もう一度ログインした後に過去のメッセージを読めません。',
    bodyKeyOnMac:
      '復旧キーはこの Mac にだけ保存されています。先に保存してください。そうしないと、もう一度ログインした後に過去のメッセージを読めません。',
    bodyKept: 'Atum はこの Mac に復旧キーを保管しているので、次回はログインするだけです。',
    forgetKey: 'この Mac のキーを削除する（売却や譲渡のとき）',
    forgetKeyICloud:
      'iCloud キーチェーンのコピーは残るため、この Mac でもう一度ログインするとロックが解除されます。そのコピーも削除するには、先に設定で iCloud キーチェーンをオフにしてください。',
    confirm: 'ログアウト',
    confirmAnyway: 'それでもログアウト',
    setUpFirst: '先に復旧キーを設定',
    writeDownFirst: '先に復旧キーを保存',
    cancel: 'キャンセル',
    failed: 'ログアウトできませんでした。接続を確認して、もう一度お試しください。'
  },
  zh: {
    title: '要在这台 Mac 上退出 Atum 吗？',
    body: '重新登录后，需要恢复密钥才能阅读以前的消息。',
    bodyNoRecovery: '你还没有保存恢复密钥。没有它，重新登录后将无法阅读以前的消息。',
    bodyUnknown: '退出前，请确认你有恢复密钥。没有它，重新登录后将无法阅读以前的消息。',
    bodyKeyOnMac: '你的恢复密钥只保存在这台 Mac 上。请先保存它，否则重新登录后将无法阅读以前的消息。',
    bodyKept: 'Atum 会在这台 Mac 上保留你的恢复密钥，下次只需登录即可。',
    forgetKey: '在这台 Mac 上删除密钥（出售或转让时）',
    forgetKeyICloud:
      'iCloud 钥匙串中的副本会保留，所以在这台 Mac 上再次登录仍会解锁。如要一并删除，请先在设置中关闭 iCloud 钥匙串。',
    confirm: '退出登录',
    confirmAnyway: '仍然退出',
    setUpFirst: '先设置恢复密钥',
    writeDownFirst: '先保存恢复密钥',
    cancel: '取消',
    failed: '无法退出登录。请检查连接后重试。'
  },
  'zh-hant': {
    title: '要在這台 Mac 上登出 Atum 嗎？',
    body: '重新登入後，需要復原金鑰才能閱讀以前的訊息。',
    bodyNoRecovery: '你還沒有儲存復原金鑰。沒有它，重新登入後將無法閱讀以前的訊息。',
    bodyUnknown: '登出前，請確認你有復原金鑰。沒有它，重新登入後將無法閱讀以前的訊息。',
    bodyKeyOnMac: '你的復原金鑰只儲存在這台 Mac 上。請先儲存它，否則重新登入後將無法閱讀以前的訊息。',
    bodyKept: 'Atum 會在這台 Mac 上保留你的復原金鑰，下次只需登入即可。',
    forgetKey: '在這台 Mac 上刪除金鑰（出售或轉讓時）',
    forgetKeyICloud:
      'iCloud 鑰匙圈中的副本會保留，所以在這台 Mac 上再次登入仍會解鎖。如要一併刪除，請先在設定中關閉 iCloud 鑰匙圈。',
    confirm: '登出',
    confirmAnyway: '仍然登出',
    setUpFirst: '先設定復原金鑰',
    writeDownFirst: '先儲存復原金鑰',
    cancel: '取消',
    failed: '無法登出。請檢查連線後再試一次。'
  }
}

export function matrixSignOutCopy(locale: Locale): SignOutCopy {
  return copies[locale]
}

/**
 * Signing out clears this Mac's message keys (main.ts signOut); the recovery key stays for the
 * person unless they choose to forget it (owner-keys.ts). Without a recovery key on the account,
 * nothing else can read the history afterwards, so the confirmation warns first and offers
 * the key. A key counts only once it is confirmed: synced from the server, or just set up or
 * restored on this Mac. Until then (the first sync is still running) it is treated as missing.
 */
export function matrixSignOutRecovery(snapshot: Pick<MatrixSnapshot, 'security'>): 'absent' | 'present' | 'unknown' {
  const security = snapshot.security

  if (security?.storage === 'present' || security?.recovery === 'ready') {
    return 'present'
  }

  return security?.storage === 'absent' ? 'absent' : 'unknown'
}

function signOutBody(copy: SignOutCopy, recovery: ReturnType<typeof matrixSignOutRecovery>) {
  return { absent: copy.bodyNoRecovery, present: copy.body, unknown: copy.bodyUnknown }[recovery]
}

/**
 * A key only this Mac holds — made quietly at first run and never written down (custody
 * `device`) — leaves with the sign-out when the person forgets it here, so it is offered first,
 * like a missing one, and the confirmation says where it is. An account with no key on the
 * server says that instead.
 */
function recoveryOnlyOnThisMac(
  snapshot: Pick<MatrixSnapshot, 'security'>,
  recovery: ReturnType<typeof matrixSignOutRecovery>
) {
  return recovery !== 'absent' && snapshot.security?.custody === 'device'
}

/**
 * What the confirmation says and offers. With the key kept on this Mac, signing out keeps it
 * (signing in again unlocks by itself) and one checkbox forgets it; only forgetting a key that
 * was never written down asks to save it first. Without a kept key, as before: the warning for a
 * missing or unknown key.
 */
export function matrixSignOutPlan(snapshot: Pick<MatrixSnapshot, 'security'>, forget: boolean) {
  const recovery = matrixSignOutRecovery(snapshot)
  const kept = Boolean(snapshot.security?.kept)
  const keyOnMac = recoveryOnlyOnThisMac(snapshot, recovery)

  if (kept && !forget) {
    return { recovery, kept, keyOnMac: false, body: 'kept' as const, missing: false }
  }

  return {
    recovery,
    kept,
    keyOnMac,
    body: keyOnMac ? ('keyOnMac' as const) : recovery,
    missing: recovery !== 'present' || keyOnMac
  }
}

function planBody(copy: SignOutCopy, plan: ReturnType<typeof matrixSignOutPlan>) {
  return plan.body === 'kept'
    ? copy.bodyKept
    : plan.body === 'keyOnMac'
      ? copy.bodyKeyOnMac
      : signOutBody(copy, plan.body)
}

function ForgetKey({
  checked,
  copy,
  disabled,
  icloud,
  onChange
}: {
  checked: boolean
  copy: SignOutCopy
  disabled: boolean
  /** The key also has a copy in iCloud Keychain, which forgetting here leaves. */
  icloud: boolean
  onChange(value: boolean): void
}) {
  return (
    <>
      <label
        className="flex items-start gap-2 text-(length:--atum-t-body) leading-(--atum-lh-body) text-(--atum-ink-muted)"
        data-matrix-sign-out-forget
      >
        <Checkbox
          checked={checked}
          className="mt-0.5 border-(--atum-line-strong)"
          disabled={disabled}
          onCheckedChange={value => onChange(value === true)}
        />
        {copy.forgetKey}
      </label>
      {checked && icloud && (
        <p className="text-(length:--atum-t-caption) text-(--atum-ink-muted)" data-matrix-sign-out-forget-icloud>
          {copy.forgetKeyICloud}
        </p>
      )}
    </>
  )
}

function useSignOut(onDone?: () => void) {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  const signOut = (forgetKey = false) => {
    setPending(true)
    setFailed(false)
    void window.atumMatrix
      .signOut(forgetKey ? { forgetKey: true } : undefined)
      .then(
        () => {
          clearMatrixWorkbenchRecents(matrixWorkbenchRecentStorage())
          onDone?.()
        },
        () => setFailed(true)
      )
      .finally(() => setPending(false))
  }

  return { failed, pending, signOut }
}

/**
 * Sign out, confirmed in place: one heading, one sentence, the destructive action and
 * Cancel. Used where a dialog would sit under the surface that asks (the launch, the account
 * cards, the sign-in window for another account). Only the account's recovery facts are read.
 */
export function MatrixSignOutConfirm({
  onCancel,
  snapshot
}: {
  onCancel(): void
  snapshot: Pick<MatrixSnapshot, 'security'>
}) {
  const copy = matrixSignOutCopy(useI18n().locale)
  const { failed, pending, signOut } = useSignOut()
  const [forget, setForget] = useState(false)
  const plan = matrixSignOutPlan(snapshot, forget)

  return (
    <div
      aria-labelledby="matrix-sign-out-title"
      className="flex w-full flex-col gap-2 text-start"
      data-matrix-sign-out-confirm
      role="group"
    >
      <p className="text-(length:--atum-t-control) font-semibold text-(--atum-ink)" id="matrix-sign-out-title">
        {copy.title}
      </p>
      <p className="text-(length:--atum-t-body) leading-(--atum-lh-body) text-(--atum-ink-muted)">
        {planBody(copy, plan)}
      </p>
      {plan.kept && (
        <ForgetKey
          checked={forget}
          copy={copy}
          disabled={pending}
          icloud={snapshot.security?.icloud === 'on'}
          onChange={setForget}
        />
      )}
      {failed && (
        <NoticeBand role="status" tone="failure">
          {copy.failed}
        </NoticeBand>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button
          aria-busy={pending || undefined}
          disabled={pending}
          onClick={() => signOut(forget)}
          size="sm"
          variant="destructive"
        >
          {plan.missing ? copy.confirmAnyway : copy.confirm}
        </Button>
        <Button disabled={pending} onClick={onCancel} size="sm" variant="text">
          {copy.cancel}
        </Button>
      </div>
    </div>
  )
}

/**
 * The sign-out confirmation as a dialog (the account menu, Settings). Unless a recovery key
 * is confirmed on the account, the first offer is the key; with one only this Mac holds,
 * saving it (Privacy & Security opens on the key itself); signing out stays one quieter
 * click away.
 */
export function MatrixSignOutDialog({
  onSetUpRecovery,
  snapshot
}: {
  /** Opens the recovery key in Settings › Privacy & Security. */
  onSetUpRecovery?(): void
  snapshot: MatrixSnapshot
}) {
  const open = useStore($matrixSignOutOpen)
  const copy = matrixSignOutCopy(useI18n().locale)
  const close = () => $matrixSignOutOpen.set(false)
  const { failed, pending, signOut } = useSignOut(close)
  const [forget, setForget] = useState(false)
  const plan = matrixSignOutPlan(snapshot, forget)
  const offerRecovery = plan.missing && Boolean(onSetUpRecovery)
  const content = useRef<HTMLDivElement>(null)

  // The question belongs to this account's window: it never outlives it.
  useEffect(() => () => $matrixSignOutOpen.set(false), [])

  // Each opening starts from keeping the key.
  useEffect(() => {
    if (open) {
      setForget(false)
    }
  }, [open])

  return (
    <Dialog onOpenChange={value => !pending && $matrixSignOutOpen.set(value)} open={open}>
      <DialogContent
        // Wide enough for Cancel, Sign out anyway and the recovery key on one row in every
        // language (Japanese is the longest at about 29rem).
        className="atum-sheet max-w-[30rem]"
        data-matrix-sign-out
        // Opened by a click: the question takes focus, not a button (no ring until the keyboard
        // moves; Tab reaches Cancel first).
        onOpenAutoFocus={event => {
          event.preventDefault()
          content.current?.focus({ preventScroll: true })
        }}
        ref={content}
        showCloseButton={false}
        tabIndex={-1}
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{planBody(copy, plan)}</DialogDescription>
        </DialogHeader>
        {plan.kept && (
          <div className="mt-4">
            <ForgetKey
              checked={forget}
              copy={copy}
              disabled={pending}
              icloud={snapshot.security?.icloud === 'on'}
              onChange={setForget}
            />
          </div>
        )}
        {failed && (
          <NoticeBand className="mt-4" role="status" tone="failure">
            {copy.failed}
          </NoticeBand>
        )}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
          <Button disabled={pending} onClick={close} variant="text">
            {copy.cancel}
          </Button>
          {offerRecovery ? (
            <>
              <Button disabled={pending} onClick={() => signOut(forget)} variant="text">
                {copy.confirmAnyway}
              </Button>
              <Button
                disabled={pending}
                onClick={() => {
                  close()

                  // The key itself, on screen at once, to write down.
                  if (plan.keyOnMac || plan.kept) {
                    $matrixRecoveryWriteDown.set(true)
                  }

                  onSetUpRecovery?.()
                }}
              >
                {plan.keyOnMac || plan.kept ? copy.writeDownFirst : copy.setUpFirst}
              </Button>
            </>
          ) : (
            <Button
              aria-busy={pending || undefined}
              disabled={pending}
              onClick={() => signOut(forget)}
              variant="destructive"
            >
              {plan.missing ? copy.confirmAnyway : copy.confirm}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
