import { type ReactNode, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'

import type { AppDescriptor } from '../../shared/app-catalog'
import type { MatrixSnapshot } from '../../shared/matrix'
import { appBotFailure, appBotFailureCopy } from '../../shared/matrix-app-bot-failure'
import { appChatCopy } from '../../shared/matrix-app-chat-copy'

/**
 * The app-chat actions (a private chat, a shared group, withdrawing the app's reader),
 * one home for their state so the app page's buttons and the Discover card's "…" menu
 * behave the same.
 */
export function useAppChatActions(app: AppDescriptor, snapshot: MatrixSnapshot) {
  const { locale } = useI18n()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  // Why it failed, when main said: an official bot's refusal names its reason.
  const [failure, setFailure] = useState<unknown>()
  const [groupOpen, setGroupOpen] = useState(false)
  const [groupName, setGroupName] = useState('')
  const bridge = window.atumMatrix.apps

  const available = app.bot
    ? snapshot.state === 'ready' && snapshot.apps?.state === 'ready' && app.bot.state === 'active' && Boolean(app.bot.device) && (app.bot.groups || !groupOpen)
    : snapshot.state === 'ready' && snapshot.apps?.state === 'ready' && app.availability === 'available' && app.link.state === 'linked'

  const run = async (action: 'chat' | 'group' | 'withdraw' = 'chat') => {
    if (!bridge || pending) {
      return
    }

    setPending(true)
    setFailed(false)
    setFailure(undefined)

    try {
      if (action === 'withdraw') {
        await bridge.withdraw(app.app_id)
      } else if (action === 'group') {
        const room = await bridge.group(app.app_id, groupName.trim(), locale)

        if (room) {
          setGroupOpen(false)
        }
      } else {
        await bridge.chat(app.app_id, locale)
      }
    } catch (error) {
      setFailed(true)
      setFailure(error)
    } finally {
      setPending(false)
    }
  }

  const botFailure = app.bot ? appBotFailure(failure) : null

  return {
    available,
    bridge,
    /** Official bot identities already live in the roster and ordinary Matrix
     * member picker.  This app-page launcher is only for legacy hosted apps;
     * offering another "New chat" or "New group" for Moon/Andy makes one
     * identity look like a separate conversation product. */
    chatCapable: !app.bot && app.matrix_room_context === 'addressed_only',
    groupCapable: !app.bot,
    failed,
    /** What a failure says: an official bot's reason by name, else that app chat is unavailable. */
    failureText: botFailure
      ? appBotFailureCopy(botFailure, locale, app.bot?.display_name)
      : appChatCopy(locale).unavailable,
    groupName,
    groupOpen,
    pending,
    run,
    setGroupName,
    setGroupOpen,
    /** Withdrawing the app's reader means something only once it is linked. */
    // A legacy copy is withdrawn by native only after this person has a
    // working official chat.  The generic Settings disconnect remains separate.
    withdrawable: !app.bot && app.link.state === 'linked'
  }
}

export type AppChatActions = ReturnType<typeof useAppChatActions>

/** Names and starts a shared app conversation; opened by a button or a menu item. */
export function AppGroupDialog({ actions, trigger }: { actions: AppChatActions; trigger?: ReactNode }) {
  const { locale } = useI18n()
  const copy = appChatCopy(locale)
  const { available, failed, failureText, groupName, groupOpen, pending, run, setGroupName, setGroupOpen } = actions

  return (
    <Dialog onOpenChange={setGroupOpen} open={groupOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent>
        <DialogTitle>{copy.newGroup}</DialogTitle>
        <form
          className="mt-2 space-y-4"
          onSubmit={event => {
            event.preventDefault()

            if (groupName.trim() && available && !pending) {
              void run('group')
            }
          }}
        >
          <Input
            aria-label={copy.groupName}
            disabled={pending}
            maxLength={200}
            onChange={event => setGroupName(event.target.value)}
            placeholder={copy.groupName}
            value={groupName}
          />
          <p className="text-sm text-muted-foreground">{copy.groupInvite}</p>
          <Button disabled={!groupName.trim() || !available || pending} type="submit">
            {copy.newGroup}
          </Button>
          {failed && (
            <NoticeBand role="status" tone="notice">
              {failureText}
            </NoticeBand>
          )}
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function AppChat({ app, snapshot }: { app: AppDescriptor; snapshot: MatrixSnapshot }) {
  const { locale } = useI18n()
  const copy = appChatCopy(locale)
  const actions = useAppChatActions(app, snapshot)

  const { available, bridge, chatCapable, failed, failureText, groupCapable, groupOpen, pending, run, withdrawable } =
    actions

  if (!bridge) {
    return null
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-matrix-app-chat>
      {chatCapable && (
        <>
          <Button disabled={!available || pending} onClick={() => void run()} size="sm" variant="secondary">
            {copy.newChat}
          </Button>
          {groupCapable && (
            <AppGroupDialog
              actions={actions}
              trigger={
                <Button disabled={!available || pending} size="sm" variant="secondary">
                  {copy.newGroup}
                </Button>
              }
            />
          )}
        </>
      )}
      {withdrawable && (
        <Button disabled={pending} onClick={() => void run('withdraw')} size="sm" variant="text">
          {copy.withdraw}
        </Button>
      )}
      {failed && !groupOpen && (
        <NoticeBand role="status" tone="notice">
          {failureText}
        </NoticeBand>
      )}
    </div>
  )
}
