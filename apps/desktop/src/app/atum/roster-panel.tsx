import { KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { ReorderableList, useSortableBindings } from '@/app/chat/sidebar/reorderable-list'
import { ATUM_AUTH_ROUTE, routeSessionId } from '@/app/routes'
import { StatusDot, type StatusTone } from '@/components/status-dot'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SearchField } from '@/components/ui/search-field'
import { Tip } from '@/components/ui/tooltip'
import { useResizeObserver } from '@/hooks/use-resize-observer'
import { useI18n } from '@/i18n'
import { $atumAppCatalog, refreshAtumAppCatalog } from '@/lib/atum-app-catalog'
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  ComposePencil,
  Download,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Upload,
  UserCircle
} from '@/lib/icons'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { $atumDmAttentionByConversation, type AtumArtifactAttention } from '@/store/atum-dm-workspace'
import {
  $atumAccountScopeId,
  $atumAccountStatus,
  $atumConnectivity,
  $atumSocialRelationships,
  $atumSortedRoster,
  ensureAtumSpecialistConversation,
  refreshAtumRoster,
  refreshAtumStatus
} from '@/store/atum-messaging'
import { $railDestination, $rosterQuery, setRosterQuery } from '@/store/atum-shell'
import { $atumUpdate, $atumUpdateBusy } from '@/store/atum-updates'
import { notify } from '@/store/notifications'

import { groupContacts } from '../dm/group-contacts'
import { GroupRoomCreateDialog } from '../dm/group-room-create-dialog'
import {
  $groupCapabilities,
  $groupOperations,
  $groupPendingCreate,
  operateGroup,
  refreshGroupCapabilities,
  refreshGroupOperations
} from '../dm/group-state'
import { dmRoute, NEW_CHAT_ROUTE } from '../routes'

import { AtumAccountMenu } from './account-footer-menu'
import { AtumAgentSyncDialog } from './agent-sync-dialog'
import {
  $atumAgents,
  $atumNewChatAgent,
  ATUM_AGENT_ID,
  type AtumAgent,
  followAtumAgentOfOpenChat,
  reorderAtumAgents,
  setAtumAgentPinned,
  talkToAtumAgent
} from './agents'
import { AtumAssistantAvatar } from './assistant-avatar'
import { $atumAssistantChats } from './assistant-chats'
import { $atumChatPins, MAX_CHAT_PINS, setAtumChatPinned, sortHostedChats } from './chat-pins'
import { ATUM_ASSISTANT_NAME_MAX } from './create-agent'
import { AtumCreateAgentDialog } from './create-agent-dialog'
import { AtumEditAgentDialog } from './edit-agent-dialog'
import {
  $atumPortableBusy,
  applyPortableAtumAgent,
  atumDefinitionDraft,
  discardPortableAtumAgentDraft,
  recoverLegacyPortableAtumAgent,
  retryPortableAtumAgent,
  setupPortableAtumAgent,
  uploadPortableAtumAgent
} from './portable-agent'
import { type AtumRosterEntry, buildAtumRoster, filterRoster, ROSTER_CHAT_FOLD } from './roster'
import { AtumStartChatDialog } from './start-chat-dialog'
import { useOpenStorefront } from './use-open-storefront'
import { UTILITY_COPY } from './utilities/copy'
import { $workspaceProtected } from './utilities/store'
import { AtumWindowControls } from './window-controls'

interface AtumRosterPanelProps {
  /** Narrow windows present the plate as a drawer over an ink scrim (mock 2g). */
  drawer?: boolean
  visible?: boolean
  onNavigated?: () => void
}

function connectivityTone(connectivity: string): StatusTone | null {
  if (connectivity === 'offline_cached' || connectivity === 'reconnecting') {
    return 'warn'
  }

  if (connectivity === 'error' || connectivity === 'auth_expired') {
    return 'bad'
  }

  return null
}

/**
 * The roster plate: search first, then the directory. The pinned Atum assistant
 * starts a new chat and carries the assistant's chats NESTED beneath it as a
 * compact, indented thread list (newest first, furled by default, folded past
 * a handful once open): one Atum identity with many chats, never a column of
 * look-alike contacts. The user's own assistants follow — pinned ones first,
 * then in the order they dragged them into — each with the same nested chats,
 * and the section closes with the way to make another. App chats and
 * person-to-person chats follow as full rows.
 *
 * What a person arranges here is THEIR assistants, which is product; Hermes
 * session pins, projects and worktrees remain organisation and stay out.
 *
 * The hosted directory ALWAYS renders one honest state — signed-out explainer
 * with a way in, skeletons while the first sync runs, an error line with a
 * retry, or the real rows. A silently absent list is the one state that must
 * never ship again.
 */
export function AtumRosterPanel({ drawer = false, visible: rosterVisible = true, onNavigated }: AtumRosterPanelProps) {
  const { locale, t } = useI18n()
  const openStorefront = useOpenStorefront()
  const query = useStore($rosterQuery)
  const chatPins = useStore($atumChatPins)
  const [downloadedVersion, setDownloadedVersion] = useState<null | string>(null)
  const conversations = useStore($atumSortedRoster)
  const artifactAttention = useStore($atumDmAttentionByConversation)
  const account = useStore($atumAccountStatus)
  const connectivity = useStore($atumConnectivity)
  const chats = useStore($atumAssistantChats)
  const agents = useStore($atumAgents)
  const newChatAgent = useStore($atumNewChatAgent)
  const groupCapabilities = useStore($groupCapabilities)
  const groupOperations = useStore($groupOperations)
  const pendingCreate = useStore($groupPendingCreate)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [startingChat, setStartingChat] = useState(false)
  // These account-backed results also feed a retained group dialog. Keep them
  // current even when its originating roster is hidden.
  useEffect(() => {
    void refreshGroupCapabilities().catch(() => {})
    void refreshGroupOperations().catch(() => {})
  }, [conversations])
  const accountId = useStore($atumAccountScopeId)
  const appCatalog = useStore($atumAppCatalog)
  const people = useStore($atumSocialRelationships)
  const location = useLocation()
  const navigate = useNavigate()
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [openingApp, setOpeningApp] = useState<string | null>(null)
  const [appOpenFailed, setAppOpenFailed] = useState<string | null>(null)
  // Closed on mount. Selecting or disclosing one assistant closes the others.
  const [unfurledAgents, setUnfurledAgents] = useState<readonly string[]>([])
  // Folded per agent: opening one agent's older chats must not unfold another's.
  const [unfoldedAgents, setUnfoldedAgents] = useState<readonly string[]>([])
  const [creatingAgent, setCreatingAgent] = useState(false)
  const [syncingAgent, setSyncingAgent] = useState<AtumAgent | null>(null)
  const [editingAgent, setEditingAgent] = useState<AtumAgent | null>(null)
  // Whose "more" menu is open: its row keeps its controls shown while the
  // pointer is over the menu rather than the row.
  const [menuAgent, setMenuAgent] = useState<string | null>(null)
  // Menus are transient anchors; modal drafts belong to the ongoing task and
  // deliberately survive roster hiding/resizing until explicitly dismissed.
  useEffect(() => {setMenuAgent(null)}, [rosterVisible, drawer])
  const portableBusy = useStore($atumPortableBusy)
  const workspaceProtected = useStore($workspaceProtected)

  // Drag the row itself after a small activation distance; a click still opens it.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const dmsAvailable = account.state === 'signed_in' || account.state === 'refreshing'
  useEffect(() => {
    if (rosterVisible && dmsAvailable && accountId) {void refreshAtumAppCatalog(accountId).catch(() => {})}
  }, [accountId, dmsAvailable, rosterVisible])

  const entries = useMemo(
    () =>
      buildAtumRoster({
        accountId,
        catalog: appCatalog.accountId === accountId ? appCatalog.apps : [],
        agents,
        assistantHint: t.atum.roster.assistantHint,
        assistantTitle: t.atum.roster.assistant,
        chats,
        conversations,
        dmsAvailable,
        locale,
        people,
        untitledChat: t.atum.roster.untitledChat
      }),
    [
      accountId,
      appCatalog.accountId,
      appCatalog.apps,
      agents,
      chats,
      conversations,
      dmsAvailable,
      locale,
      people,
      t.atum.roster.assistant,
      t.atum.roster.assistantHint,
      t.atum.roster.untitledChat
    ]
  )

  const visible = useMemo(() => filterRoster(entries, query), [entries, query])
  const searching = query.trim().length > 0

  // A chat row is active for every id that resolves to it (live id or lineage
  // root), since the URL may carry either across auto-compression.
  const routedSessionId = routeSessionId(location.pathname)

  // One group per agent, in roster order: the agent's own row plus the chats
  // it owns. A group shows when the agent row matches OR any of its chats do,
  // so a search that finds a chat still lands it under the agent that owns it.
  const agentGroups = useMemo(() => {
    const byAgent = new Map<string, { agent: AtumRosterEntry | null; chats: AtumRosterEntry[] }>()

    for (const entry of visible) {
      if (entry.kind !== 'assistant' && entry.kind !== 'chat') {
        continue
      }

      const group = byAgent.get(entry.agentId) ?? { agent: null, chats: [] }

      if (entry.kind === 'assistant') {
        group.agent = entry
      } else {
        group.chats.push(entry)
      }

      byAgent.set(entry.agentId, group)
    }

    // A search that matches only chats must still show whose they are, so a
    // group whose agent row was filtered out borrows it from the full list
    // rather than rendering a headless thread.
    return [...byAgent.entries()].map(([agentId, group]) => ({
      agentId,
      ...group,
      agent: group.agent ?? entries.find(entry => entry.kind === 'assistant' && entry.agentId === agentId) ?? null
    }))
  }, [entries, visible])

  const appEntries = visible.filter(entry => entry.kind === 'app')

  const directEntries = visible.filter(
    entry => entry.kind === 'direct' || entry.kind === 'group' || entry.kind === 'unsupported'
  )

  const hostedEntries = sortHostedChats([...appEntries, ...directEntries], chatPins)
  const hasProvisionedHostedEntries = hostedEntries.some(entry => entry.conversationId !== null)

  // The roster stays on screen while Discover owns the chat plate, so a row
  // click there changes the route under a surface that is not showing it.
  // Every roster navigation returns the plate to chat; nothing else may call
  // navigate() from this panel.
  const openRoute = (route: string) => {
    $railDestination.set('chat')
    navigate(route)
  }

  // Every agent row leads to the same composer, so the pathname alone cannot
  // say which one is current: the agent the next chat belongs to can.
  const isCurrent = (entry: AtumRosterEntry) =>
    entry.kind === 'assistant'
      ? location.pathname === NEW_CHAT_ROUTE && entry.agentId === newChatAgent
      : location.pathname === entry.route

  const open = async (entry: AtumRosterEntry) => {
    if (entry.kind === 'app' && entry.appId && !entry.conversationId) {
      if (openingApp) {
        return
      }

      setOpeningApp(entry.appId)
      setAppOpenFailed(null)

      try {
        const conversationId = await ensureAtumSpecialistConversation(entry.appId)
        openRoute(dmRoute(conversationId))
        onNavigated?.()
      } catch (error) {
        // An account switch deliberately invalidates the old account's
        // in-flight ensure. The new account must not inherit a false open
        // failure from that obsolete request.
        if (!(error instanceof Error && error.message === 'atum_account_changed')) {
          setAppOpenFailed(entry.appId)
        }
      } finally {
        setOpeningApp(null)
      }

      return
    }

    // Choosing an agent IS starting a chat with it, so the click points the
    // composer at that agent before going there. The master and a named agent
    // behave identically, which is also what re-points the composer back at
    // Atum when the user returns to it after making someone new.
    // Re-tapping the agent you are already writing to leaves your draft alone;
    // pointing the composer somewhere new deliberately starts fresh.
    if (entry.kind === 'assistant') {
      setUnfurledAgents([entry.agentId])

      const agent = agents.find(candidate => candidate.id === entry.agentId)

      if (agent?.localProfileId === null) {
        try {
          const profileName =
            agent.definitionState === 'setup'
              ? await setupPortableAtumAgent(agent)
              : await recoverLegacyPortableAtumAgent(agent)

          talkToAtumAgent(profileName)
          openRoute(NEW_CHAT_ROUTE)
          onNavigated?.()
        } catch (error) {
          const code = ipcErrorMessage(error)
          notify({
            kind: 'error',
            message:
              code === 'google_workspace_local_only'
                ? UTILITY_COPY[locale].workspaceLocalOnly
                : code === 'assistant_source_computer_needed'
                ? t.atum.agents.sourceComputerNeeded
                : code === 'assistant_missing_skills'
                  ? t.atum.agents.missingSkills
                  : t.atum.agents.setupFailed
          })
        }

        return
      }

      if (!isCurrent(entry)) {
        talkToAtumAgent(entry.agentId)
      }
    }

    // Opening a chat moves the app to the agent that owns it, so the composer
    // should follow rather than stay aimed at whoever was picked last.
    if (entry.kind === 'chat') {
      followAtumAgentOfOpenChat()
    }

    if (entry.route) {
      openRoute(entry.route)
      onNavigated?.()
    }
  }

  // The new-chat control always starts fresh, even for the agent already
  // holding the composer: unlike tapping the row, it is an explicit ask.
  const startChat = (agentId: string) => {
    talkToAtumAgent(agentId)
    openRoute(NEW_CHAT_ROUTE)
    onNavigated?.()
  }

  const upload = (agent: AtumAgent) => {
    void uploadPortableAtumAgent(agent).catch(error => {
      const code = ipcErrorMessage(error)

      if (code === 'assistant_definition_conflict') {
        notify({
          action: {
            label: t.atum.agents.retrySync,
            onClick: () => void retryPortableAtumAgent(agent).catch(() => undefined)
          },
          kind: 'warning',
          message: t.atum.agents.changedElsewhere,
          title: t.atum.agents.syncConflict
        })

        return
      }

      notify({ kind: 'error', message: code === 'google_workspace_local_only' ? UTILITY_COPY[locale].workspaceLocalOnly : t.atum.agents.syncFailed })
    })
  }

  const applyCloudVersion = (agent: AtumAgent) => {
    void applyPortableAtumAgent(agent)
      .then(profileName => {
        talkToAtumAgent(profileName)
        openRoute(NEW_CHAT_ROUTE)
        onNavigated?.()
      })
      .catch(error => {
        const code = ipcErrorMessage(error)
        notify({
          kind: 'error',
          message: code === 'assistant_missing_skills' ? t.atum.agents.missingSkills : t.atum.agents.applyCloudFailed
        })
      })
  }

  const toggleUnfurled = (agentId: string) => setUnfurledAgents(current => (current.includes(agentId) ? [] : [agentId]))

  const retry = () => {
    void refreshAtumStatus()
    void refreshAtumRoster()
  }

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return
    }

    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-roster-row]') ?? [])
    const current = rows.findIndex(row => row === document.activeElement)
    const next = event.key === 'ArrowDown' ? Math.min(rows.length - 1, current + 1) : Math.max(0, current - 1)

    event.preventDefault()
    rows[next]?.focus()
  }

  const renderChatRow = (entry: AtumRosterEntry) => (
    <AtumChatRow
      active={routedSessionId !== null && entry.sessionIds.includes(routedSessionId)}
      entry={entry}
      finishedLabel={t.atum.roster.finished}
      key={entry.id}
      onOpen={() => void open(entry)}
    />
  )

  type AgentGroup = { agentId: string; agent: AtumRosterEntry | null; chats: AtumRosterEntry[] }
  type SortableBindings = ReturnType<typeof useSortableBindings>

  const controlClass =
    'relative grid size-7 shrink-0 place-items-center rounded-[var(--atum-r-control)] text-(--atum-ink-muted) after:absolute after:-inset-1 hover:bg-(--atum-hover) hover:text-(--atum-ink)'

  // The row's controls surface on hover, focus, or while their menu is open,
  // so a resting roster reads as names, not as a toolbar per line.
  const revealClass =
    'opacity-0 transition-opacity group-hover/agent:opacity-100 group-focus-within/agent:opacity-100 group-data-[menu-open]/agent:opacity-100 motion-reduce:transition-none'

  // Row controls: new chat, assistant options, and session disclosure.
  const renderAgentControls = (group: AgentGroup) => {
    const agent = agents.find(candidate => candidate.id === group.agentId) ?? null
    const master = group.agentId === ATUM_AGENT_ID
    const unfurled = unfurledAgents.includes(group.agentId)
    const copy = t.atum.agents

    return (
      <div className="flex shrink-0 items-center gap-px pe-1" data-atum-agent-controls>
        {agent?.localProfileId && (
          <Tip label={copy.newChat}>
            <button
              aria-label={copy.newChat}
              className={cn(controlClass, revealClass)}
              data-atum-new-chat
              data-icon-only
              onClick={() => startChat(group.agentId)}
              type="button"
            >
              {/* Compose, not "add a message": the pencil is what every
                messaging client puts on this action, and it reads as
                writing rather than as a second plus beside the header's. */}
              <ComposePencil className="size-4" />
            </button>
          </Tip>
        )}
        {agent && (
          <DropdownMenu
            onOpenChange={open => setMenuAgent(open ? group.agentId : null)}
            open={rosterVisible && menuAgent === group.agentId}
          >
            <Tip label={copy.more}>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label={copy.more}
                  className={cn(controlClass, revealClass)}
                  data-atum-agent-menu
                  data-icon-only
                  type="button"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent align="end" onCloseAutoFocus={event => {if (!rosterVisible) {event.preventDefault()}}}>
              {agent.localProfileId && (
                <DropdownMenuItem data-atum-agent-edit onSelect={() => setEditingAgent(agent)}>
                  <Pencil aria-hidden />
                  {copy.edit}
                </DropdownMenuItem>
              )}
              {agent.hostedId && window.hermesDesktop?.agentSync && <DropdownMenuItem onSelect={() => setSyncingAgent(agent)}>
                {locale === 'vi' ? 'Đồng bộ trợ lý…' : 'Agent sync…'}
              </DropdownMenuItem>}
              {agent.localProfileId ? (
                <DropdownMenuItem
                  data-atum-agent-sync
                  disabled={workspaceProtected || portableBusy === agent.hostedId}
                  onSelect={() => upload(agent)}
                  title={workspaceProtected ? UTILITY_COPY[locale].workspaceLocalOnly : undefined}
                >
                  <Upload aria-hidden />
                  {atumDefinitionDraft(agent) ? copy.retrySync : copy.sync}
                </DropdownMenuItem>
              ) : agent.definitionState === 'setup' ? (
                <DropdownMenuItem
                  data-atum-agent-setup
                  disabled={portableBusy === agent.hostedId}
                  onSelect={() => void open(group.agent!)}
                >
                  <Download aria-hidden />
                  {copy.setupHere}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  data-atum-agent-check-computer
                  disabled={portableBusy === agent.hostedId}
                  onSelect={() => void open(group.agent!)}
                >
                  <AlertCircle aria-hidden />
                  {copy.checkThisComputer}
                </DropdownMenuItem>
              )}
              {agent.localProfileId && !agent.isDefault && agent.hostedId && agent.definitionState === 'available' && (
                <DropdownMenuItem
                  data-atum-agent-apply-cloud
                  disabled={portableBusy === agent.hostedId}
                  onSelect={() => applyCloudVersion(agent)}
                  title={copy.applyCloudHint}
                >
                  <Download aria-hidden />
                  {copy.applyCloudVersion}
                </DropdownMenuItem>
              )}
              {atumDefinitionDraft(agent) && (
                <DropdownMenuItem data-atum-agent-discard-draft onSelect={() => discardPortableAtumAgentDraft(agent)}>
                  {copy.discardLocalDraft}
                </DropdownMenuItem>
              )}
              {!master && (
                <DropdownMenuItem data-atum-agent-pin onSelect={() => setAtumAgentPinned(agent.id, !agent.pinned)}>
                  {agent.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
                  {agent.pinned ? copy.unpin : copy.pin}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {group.chats.length > 0 && !searching && (
          <Tip label={unfurled ? copy.hideChats : copy.showChats(group.chats.length)}>
            <button
              aria-expanded={unfurled}
              aria-label={unfurled ? copy.hideChats : copy.showChats(group.chats.length)}
              className={controlClass}
              data-atum-agent-toggle
              data-icon-only
              onClick={() => toggleUnfurled(group.agentId)}
              type="button"
            >
              <ChevronRight
                className={cn('size-4 transition-transform motion-reduce:transition-none', unfurled && 'rotate-90')}
              />
            </button>
          </Tip>
        )}
      </div>
    )
  }

  // An agent and its nested chats are one group: the divider sits under the
  // whole thread, and the chats read as that agent's, not as more contacts.
  // The thread is furled until the user opens it; a search shows every match.
  const renderAgentGroup = (group: AgentGroup, sortable: SortableBindings | null) => {
    const agent = agents.find(candidate => candidate.id === group.agentId) ?? null

    const needsRename = Boolean(
      agent?.localProfileId && !agent.isDefault && agent.title.trim().length > ATUM_ASSISTANT_NAME_MAX
    )

    const unfurled = searching || unfurledAgents.includes(group.agentId)
    const unfolded = unfoldedAgents.includes(group.agentId)
    const folded = searching || unfolded ? 0 : Math.max(0, group.chats.length - ROSTER_CHAT_FOLD)
    const shown = folded > 0 ? group.chats.slice(0, ROSTER_CHAT_FOLD) : group.chats
    const foldable = folded > 0 || (unfolded && !searching && group.chats.length > ROSTER_CHAT_FOLD)

    return (
      <div
        className={cn('relative', sortable?.dragging && 'atum-glass-card z-10')}
        data-agent-group={group.agentId}
        data-pinned-assistant={group.agentId === ATUM_AGENT_ID || undefined}
        key={`agent-group:${group.agentId}`}
        ref={sortable?.ref}
        style={sortable?.style}
      >
        {group.agent ? (
          // The group shell paints selection and hover for the whole line,
          // row and controls together, so the lift never stops short of the
          // icons that belong to it.
          <div
            className="atum-row group/agent flex items-center gap-1"
            data-current={isCurrent(group.agent) ? 'true' : undefined}
            data-menu-open={menuAgent === group.agentId || undefined}
          >
            <div className="min-w-0 flex-1">{renderRosterRow(group.agent, true, sortable)}</div>
            {renderAgentControls(group)}
          </div>
        ) : null}
        {needsRename && agent && (
          <div
            className="flex items-center gap-2 px-2.5 pt-1 text-(length:--atum-t-caption) text-(--atum-danger)"
            data-atum-agent-name-too-long
            role="alert"
          >
            <span className="min-w-0 flex-1">{t.atum.agents.nameTooLong}</span>
            <button
              className="shrink-0 font-medium underline decoration-current underline-offset-2"
              data-atum-agent-rename
              onClick={() => setEditingAgent(agent)}
              type="button"
            >
              {t.atum.agents.edit}
            </button>
          </div>
        )}
        {group.agent && unfurled && shown.length > 0 && (
          <div className="mt-0.5" data-roster-chats>
            {shown.map(renderChatRow)}
            {foldable && (
              <button
                aria-expanded={unfolded}
                className="atum-row block w-full py-1 pe-2 ps-[calc(0.5rem+var(--atum-avatar-md)+0.625rem)] text-left text-(length:--atum-t-caption) leading-(--atum-lh-caption) font-medium text-(--atum-ink-muted) hover:text-(--atum-ink)"
                data-roster-chats-toggle
                onClick={() =>
                  setUnfoldedAgents(current =>
                    current.includes(group.agentId)
                      ? current.filter(id => id !== group.agentId)
                      : [...current, group.agentId]
                  )
                }
                type="button"
              >
                {unfolded ? t.atum.roster.showFewerChats : t.atum.roster.showMoreChats(folded)}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  // A block the user can drag within. Pinned assistants and the rest are two
  // blocks with their own drag context, so a pull never crosses the pin line;
  // the persisted order is always the whole subordinate list as it reads.
  const renderSortableBlock = (groups: AgentGroup[], others: string[], pinnedFirst: boolean) => {
    if (groups.length === 0) {
      return null
    }

    const ids = groups.map(group => group.agentId)

    return (
      <ReorderableList
        ids={ids}
        onReorder={next => reorderAtumAgents(pinnedFirst ? [...next, ...others] : [...others, ...next])}
        sensors={sensors}
      >
        {groups.map(group => (
          <SortableAgentGroup id={group.agentId} key={`agent-group:${group.agentId}`}>
            {bindings => renderAgentGroup(group, bindings)}
          </SortableAgentGroup>
        ))}
      </ReorderableList>
    )
  }

  // The master first and alone; then the user's own assistants, pinned block
  // above the rest. Searching shows the same order without drag handles.
  const renderAgentGroups = () => {
    const master = agentGroups.find(group => group.agentId === ATUM_AGENT_ID)
    const own = agentGroups.filter(group => group.agentId !== ATUM_AGENT_ID)
    const pinnedIds = new Set(agents.filter(agent => agent.pinned).map(agent => agent.id))
    const pinnedGroups = own.filter(group => pinnedIds.has(group.agentId))
    const looseGroups = own.filter(group => !pinnedIds.has(group.agentId))

    return (
      <>
        <AtumSectionLabel>{t.atum.roster.assistants}</AtumSectionLabel>
        {master && (
          <div className="flex flex-col gap-0.5" data-atum-master-group>
            {renderAgentGroup(master, null)}
          </div>
        )}
        <div className="flex flex-col gap-0.5" data-atum-own-agents>
          {searching ? (
            own.map(group => renderAgentGroup(group, null))
          ) : (
            <>
              {renderSortableBlock(
                pinnedGroups,
                looseGroups.map(group => group.agentId),
                true
              )}
              {renderSortableBlock(
                looseGroups,
                pinnedGroups.map(group => group.agentId),
                false
              )}
            </>
          )}
        </div>
      </>
    )
  }

  // Mock 1a: the Atum row's second line is what Atum is up to. The app has no
  // task sentence, so the latest chat's title and time stand in for it, and
  // the "start a new chat" hint only shows before any chat exists.

  const renderRosterRow = (entry: AtumRosterEntry, framed: boolean, sortable: SortableBindings | null = null) => (
    <AtumRosterRow
      active={isCurrent(entry)}
      attention={entry.kind === 'assistant' ? null : (artifactAttention[entry.id] ?? null)}
      attentionLabel={
        artifactAttention[entry.id] === 'failed'
          ? t.atum.workspace.completionFailed
          : t.atum.workspace.completionComplete
      }
      badgeLabel={entry.verified ? t.atum.roster.badgeFirstParty : t.atum.roster.badgePartner}
      badgeShort={entry.verified ? t.atum.roster.badgeFirstPartyShort : t.atum.roster.badgePartnerShort}
      busy={entry.appId !== null && openingApp === entry.appId}
      dragProps={sortable?.dragHandleProps}
      entry={entry}
      framed={framed}
      key={entry.id}
      onOpen={() => void open(entry)}
      pinnedLabel={t.sidebar.pinned}
      unreadLabel={t.atum.roster.unread}
    />
  )

  const renderRow = (entry: AtumRosterEntry) => {
    const pinned = chatPins.includes(entry.id)
    const atLimit = !pinned && chatPins.length >= MAX_CHAT_PINS

    return (
      <div className="atum-row group/chat flex items-center" data-atum-chat-pinned={pinned || undefined} key={entry.id}>
        <div className="min-w-0 flex-1">{renderRosterRow(entry, true)}</div>
        {pinned && <Pin aria-label={t.sidebar.pinned} className="size-3 shrink-0 text-(--atum-ink-faint)" role="img" />}
        <DropdownMenu>
          <Tip label={t.atum.agents.more}>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={t.atum.agents.more}
                className="atum-icon-btn me-1 size-7 shrink-0 opacity-0 group-hover/chat:opacity-100 group-focus-within/chat:opacity-100"
                data-icon-only
                type="button"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={atLimit} onSelect={() => setAtumChatPinned(entry.id, !pinned)}>
              {pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
              {atLimit ? t.atum.roster.pinLimit : pinned ? t.atum.agents.unpin : t.atum.agents.pin}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  // The hosted directory state, exactly one of four. Skeletons only stand in
  // for the FIRST sync — once rows exist they stay on screen while refreshing.
  const hostedState: 'error' | 'loading' | 'rows' | 'signedOut' | 'empty' = !dmsAvailable
    ? 'signedOut'
    : hasProvisionedHostedEntries
      ? 'rows'
      : connectivity === 'error'
        ? 'error'
        : connectivity === 'loading'
          ? 'loading'
          : 'empty'

  const updateStatus = useStore($atumUpdate)
  const updateBusy = useStore($atumUpdateBusy)
  useEffect(() => {
    if (updateStatus?.state === 'downloaded') {
      setDownloadedVersion(updateStatus.version)
    }
  }, [updateStatus])

  const accountLabel = account.account?.displayName || account.account?.handle || ''
  const accountInitial = account.account ? accountLabel.trim().charAt(0).toLocaleUpperCase() || null : null
  const tone = connectivityTone(connectivity)

  return (
    <aside
      className="atum-sidebar relative flex h-full w-(--atum-l-roster) shrink-0 flex-col overflow-hidden [-webkit-app-region:no-drag]"
      data-atum-drawer={drawer ? 'true' : undefined}
      data-atum-roster
    >
      <h1 className="sr-only">{t.atum.roster.title}</h1>
      {groupOperations.some(
        row => row.conversationId === null && ['queued', 'sending', 'failed_retryable'].includes(row.state)
      ) && (
        <p className="px-3 py-2 text-xs text-(--atum-ink-muted)" role="status">
          {t.dm.group.create.queued}
        </p>
      )}
      <GroupRoomCreateDialog
        capabilities={groupCapabilities}
        contacts={groupContacts(people, conversations, accountId)}
        createOperationId={() => crypto.randomUUID()}
        key={accountId ?? 'signed-out'}
        onCreated={result => {
          if (result.state === 'sent' && result.conversationId) {
            openRoute(dmRoute(result.conversationId))
          }
        }}
        onOpenChange={setCreatingGroup}
        onOperate={operateGroup}
        onPendingCreateChange={input => {
          if (accountId === $atumAccountScopeId.get()) {
            $groupPendingCreate.set(input)
          }
        }}
        open={creatingGroup}
        operationResults={groupOperations}
        pendingCreate={pendingCreate}
      />
      <AtumCreateAgentDialog onOpenChange={setCreatingAgent} open={creatingAgent} />
      <AtumStartChatDialog
        entries={entries}
        // Through the one opener, which sets the SHELF as well as the rail.
        // This handler predates the storefront: flipping the rail bare now
        // lands on Featured, because arriving at Discover reseeds the shelf —
        // so "Add friends" stopped reaching the People search it names.
        onAddFriends={() => openStorefront('people', { beforeNavigate: onNavigated })}
        onCreateAgent={() => setCreatingAgent(true)}
        onCreateGroup={groupCapabilities?.available ? () => setCreatingGroup(true) : null}
        onOpenChange={setStartingChat}
        onPick={entry => void open(entry)}
        open={startingChat}
      />
      <AtumAgentSyncDialog agent={syncingAgent} onClose={() => setSyncingAgent(null)} />
      <AtumEditAgentDialog agent={editingAgent} onClose={() => setEditingAgent(null)} />

      {/* The sidebar's top row: the native lights and the collapse control,
          at the shell's one row height. This column is leftmost whenever it
          shows, so the controls are always here while it does, and on the
          main column's row otherwise (`window-controls.tsx`). A drag region,
          like every top row. */}
      <div
        className="flex h-(--atum-l-header) shrink-0 items-center ps-3 pe-2 [-webkit-app-region:drag]"
        data-atum-roster-header
      >
        <AtumWindowControls />
      </div>

      {/* Search, and the one way to start something new. Discover is no longer
          beside the search field: a destination is not a search action, and it
          lives in the nav launcher at the window's edge now. */}
      <div className="flex shrink-0 items-center gap-1.5 px-3 pt-1" data-atum-search-actions>
        <SearchField
          aria-label={t.atum.roster.search}
          containerClassName="h-[2.125rem] min-w-0 flex-1 rounded-[var(--atum-r-row)] border-none bg-(--atum-sunk) px-2 text-[0.8125rem] !opacity-100 transition-colors focus-within:bg-(--atum-hover)"
          inputClassName="min-w-0 flex-1 text-(--atum-ink) placeholder:text-(--atum-ink-faint)"
          inputRef={searchRef}
          onChange={setRosterQuery}
          placeholder={t.atum.roster.search}
          value={query}
        />
        {/* One question — who do you want to talk to? — instead of a menu
            whose first item duplicated the master's own roster row. */}
        <Tip label={t.atum.roster.startChat}>
          <button
            aria-label={t.atum.roster.startChat}
            className="atum-primary-icon size-7 shrink-0"
            data-atum-create-menu
            data-icon-only
            onClick={() => setStartingChat(true)}
            type="button"
          >
            <Plus className="size-4" />
          </button>
        </Tip>
      </div>

      {/* Result count is announced, not drawn — the list itself is the answer. */}
      <span aria-live="polite" className="sr-only">
        {query ? t.atum.roster.results(visible.length) : ''}
      </span>

      {/* No `role="list"`: overriding the rows' roles would cost them their
          button semantics, and the rows ARE the interaction. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2" onKeyDown={onListKeyDown} ref={listRef}>
        {searching && visible.length === 0 ? (
          <div className="grid min-h-32 place-items-center px-3 text-center">
            <div>
              <div className="text-sm font-medium text-(--atum-ink)">{t.atum.roster.emptySearch}</div>
              <div className="mt-1 text-xs text-(--atum-ink-muted)">{t.atum.roster.emptySearchHint}</div>
              {/* Searching the roster and finding nothing used to offer
                  "Search Atum" right here. That escape hatch still has to
                  exist — it just points at Discover now instead of unfolding a
                  second search inside the list. */}
              {dmsAvailable && (
                <button
                  className="mt-2 text-xs font-medium text-(--atum-ink) underline decoration-(--atum-line-strong) underline-offset-2 hover:decoration-(--atum-ink-muted)"
                  data-roster-empty-discover
                  // Same reason as "Add friends" above: a bare rail flip lands
                  // on Featured now that arriving at Discover reseeds the
                  // shelf. This button is an empty PEOPLE search, so it must
                  // name the People shelf.
                  onClick={() => openStorefront('people', { beforeNavigate: onNavigated })}
                  type="button"
                >
                  {t.atum.roster.emptySearchDiscover}
                </button>
              )}
            </div>
          </div>
        ) : searching ? (
          <>
            {renderAgentGroups()}
            {hostedEntries.length > 0 && <AtumSectionLabel>{t.atum.roster.specialists}</AtumSectionLabel>}
            <div className="flex flex-col gap-0.5">{hostedEntries.map(renderRow)}</div>
          </>
        ) : (
          <>
            <div data-roster-list>
              {renderAgentGroups()}
              {/* The assistants section ends with the way to grow it — an
                  affordance, not a row, so arrow keys skip it and it is never
                  mistaken for an assistant with nobody in it. */}
              <div className="pt-0.5" data-atum-agents-foot>
                <button
                  className="atum-row mt-2 flex h-9 w-full items-center gap-2.5 bg-(--atum-sunk) px-2.5 text-left text-[0.84375rem] font-medium text-(--atum-ink-muted) hover:text-(--atum-ink)"
                  data-atum-create-agent
                  onClick={() => setCreatingAgent(true)}
                  type="button"
                >
                  <Plus aria-hidden className="size-[1.125rem] shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{t.atum.agents.create}</span>
                </button>
              </div>
              <AtumSectionLabel>{t.atum.roster.specialists}</AtumSectionLabel>
              <div className="flex flex-col gap-0.5" data-atum-specialists>
                {hostedEntries.map(renderRow)}
              </div>
            </div>
            {appEntries.length > 0 && (
              <>
                {appOpenFailed && (
                  <div className="flex items-center gap-2 px-3 py-1" role="alert">
                    <p className="min-w-0 flex-1 text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
                      {t.atum.roster.openAppFailed}
                    </p>
                    <button
                      className="shrink-0 text-(length:--atum-t-caption) leading-(--atum-lh-caption) font-medium text-(--atum-ink) underline decoration-(--atum-line-strong) underline-offset-2"
                      onClick={() => {
                        const entry = appEntries.find(candidate => candidate.appId === appOpenFailed)

                        if (entry) {
                          void open(entry)
                        }
                      }}
                      type="button"
                    >
                      {t.atum.roster.retry}
                    </button>
                  </div>
                )}
              </>
            )}

            <div data-roster-state="hosted">
              {hostedState === 'signedOut' && (
                <div className="px-3 py-2">
                  <p className="text-(length:--atum-t-body) leading-(--atum-lh-body) font-medium text-(--atum-ink)">
                    {t.atum.roster.signedOutTitle}
                  </p>
                  <p className="mt-0.5 text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
                    {t.atum.roster.signedOutBody}
                  </p>
                  <button
                    className="mt-1.5 text-(length:--atum-t-body) leading-(--atum-lh-body) font-medium text-(--atum-ink) underline decoration-(--atum-line-strong) underline-offset-2 hover:decoration-(--atum-ink-muted)"
                    onClick={() => openRoute(ATUM_AUTH_ROUTE)}
                    type="button"
                  >
                    {t.atum.roster.signIn}
                  </button>
                </div>
              )}

              {hostedState === 'loading' && (
                <div aria-hidden="true" className="space-y-1 px-1 py-1">
                  {[0, 1, 2].map(index => (
                    <div className="flex h-14 items-center gap-[11px] px-2" key={index}>
                      <div className="size-(--atum-avatar-md) shrink-0 animate-pulse rounded-(--atum-r-avatar-md) bg-(--atum-sunk) opacity-60 motion-reduce:animate-none" />
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="h-2.5 w-2/5 animate-pulse rounded-full bg-(--atum-sunk) opacity-60 motion-reduce:animate-none" />
                        <div className="h-2 w-3/5 animate-pulse rounded-full bg-(--atum-sunk) opacity-60 motion-reduce:animate-none" />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {hostedState === 'error' && (
                <div className="flex items-center gap-2 px-3 py-2">
                  <p className="min-w-0 flex-1 text-(length:--atum-t-body) leading-(--atum-lh-body) text-(--atum-ink-muted)">
                    {t.atum.roster.loadFailed}
                  </p>
                  <button
                    className="shrink-0 text-(length:--atum-t-body) leading-(--atum-lh-body) font-medium text-(--atum-ink) underline decoration-(--atum-line-strong) underline-offset-2 hover:decoration-(--atum-ink-muted)"
                    onClick={retry}
                    type="button"
                  >
                    {t.atum.roster.retry}
                  </button>
                </div>
              )}

              {hostedState === 'empty' && (
                <p className="px-3 py-2 text-(length:--atum-t-body) leading-(--atum-lh-body) text-(--atum-ink-muted)">
                  {t.atum.roster.emptyChats}
                </p>
              )}
            </div>

            {/* The list ends with a way to grow it — an affordance, not a row,
                so it is never mistaken for a chat with nobody in it. */}
          </>
        )}
      </div>

      {/* The foot: one 36px row above a hairline — the account, and the relaunch
          control while an update waits. It used to be a 44px row inside 10px of
          padding top and bottom, thicker than any row above it. */}
      <div
        className="mx-3 mb-2 flex shrink-0 items-center gap-1.5 border-t border-(--atum-line) pt-1.5"
        data-atum-roster-footer
      >
        <AtumAccountMenu anchorState={rosterVisible ? drawer ? 'drawer' : 'sidebar' : 'hidden'}>
          <button
            aria-label={t.atum.nav.account}
            className="atum-row flex h-9 min-w-0 flex-1 items-center gap-2 px-2 text-left"
            data-atum-account-trigger
            type="button"
          >
            <span className="atum-avatar relative grid size-(--atum-avatar-sm) shrink-0 place-items-center bg-(--atum-sunk) text-(length:--atum-t-caption) font-medium">
              {account.account?.avatarUrl ? (
                <img alt="" className="size-full object-cover" src={account.account.avatarUrl} />
              ) : accountInitial ? (
                <span aria-hidden>{accountInitial}</span>
              ) : (
                <UserCircle aria-hidden className="size-3.5" />
              )}
              {tone && <StatusDot className="absolute -bottom-0.5 -right-0.5" tone={tone} />}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-(length:--atum-t-control) font-medium text-(--atum-ink)"
              data-atum-account-name
            >
              {accountLabel || t.atum.nav.account}
            </span>
          </button>
        </AtumAccountMenu>
        {downloadedVersion && (
          <Tip label={updateBusy ? t.settings.about.updateWaitForWork : t.atum.nav.relaunchUpdate}>
            <button
              aria-label={t.atum.nav.relaunchUpdate}
              className="atum-primary-icon size-7 shrink-0 rounded-full"
              data-atum-relaunch-update
              data-icon-only
              disabled={updateBusy}
              onClick={() =>
                void window.hermesDesktop.appUpdate
                  ?.relaunch()
                  .then(result => {
                    if (!result.accepted) {
                      notify({ kind: 'info', message: t.settings.about.updateWaitForWork })
                    }
                  })
                  .catch(() => notify({ kind: 'error', message: t.settings.about.cantUpdate }))
              }
              type="button"
            >
              <Download aria-hidden className="size-4" />
            </button>
          </Tip>
        )}
      </div>
    </aside>
  )
}

/**
 * One draggable agent group. The hook has to run inside the block's sortable
 * context, and the group's markup lives in the panel's closures, so this is a
 * thin bridge that hands the bindings back down.
 */
function SortableAgentGroup({
  children,
  id
}: {
  children: (bindings: ReturnType<typeof useSortableBindings>) => React.ReactNode
  id: string
}) {
  return <>{children(useSortableBindings(id))}</>
}

function AtumRosterRow({
  active,
  attention,
  attentionLabel,
  badgeLabel,
  badgeShort,
  busy,
  entry,
  framed = false,
  dragProps,
  onOpen,
  pinnedLabel,
  unreadLabel
}: {
  active: boolean
  dragProps?: ReturnType<typeof useSortableBindings>['dragHandleProps']
  attention: AtumArtifactAttention | null
  attentionLabel: string
  badgeLabel: string
  badgeShort: string
  busy: boolean
  entry: AtumRosterEntry
  /** The surrounding group paints selection and hover; the row stays flat. */
  framed?: boolean
  onOpen: () => void
  pinnedLabel: string
  unreadLabel: (count: number) => string
}) {
  const label = [
    entry.title,
    entry.kind === 'app' ? badgeLabel : null,
    entry.role || entry.preview || null,
    entry.unreadCount > 0 ? unreadLabel(entry.unreadCount) : null,
    attention ? attentionLabel : null
  ]
    .filter(Boolean)
    .join(', ')

  const line2 = entry.role || entry.preview
  const activityMs = entry.activityAt ? Date.parse(entry.activityAt) : Number.NaN

  // Only the master is pinned. Describing every agent row as pinned repeated
  // one element id per agent and told a screen-reader user that an assistant
  // they can freely remove is fixed in place.
  const pinnedDescriptionId =
    entry.kind === 'assistant' && entry.agentId === ATUM_AGENT_ID ? 'atum-roster-pinned' : undefined

  return (
    <div>
      {pinnedDescriptionId && (
        <span className="sr-only" id={pinnedDescriptionId}>
          {pinnedLabel}
        </span>
      )}
      <button
        {...dragProps}
        aria-busy={busy || undefined}
        aria-current={active ? 'page' : undefined}
        aria-describedby={pinnedDescriptionId}
        aria-label={label}
        className={cn(
          // Mock 1a row: 44px, padding 0 8, gap 10, radius 10.
          'flex h-11 w-full items-center gap-2.5 px-2 text-left',
          // Selection is a flat fill (§3), painted by the group shell for agent rows.
          !framed && 'atum-row',
          dragProps && 'cursor-grab touch-none active:cursor-grabbing'
        )}
        data-roster-row
        disabled={busy}
        onClick={onOpen}
        type="button"
      >
        <span className="relative shrink-0">
          {entry.kind === 'assistant' ? (
            <AtumAssistantAvatar
              avatarUrl={entry.avatarUrl}
              brand={entry.agentId === ATUM_AGENT_ID}
              className="size-(--atum-avatar-md) rounded-(--atum-r-avatar) text-[0.8125rem] leading-none"
              id={entry.agentId}
              name={entry.title}
              rosterAvatar
            />
          ) : entry.emoji ? (
            // The symbol its maker picked. Wearing Atum's mark would make a
            // roster of assistants a column of identical logos.
            <span
              aria-hidden="true"
              className="ak-avatar atum-avatar grid size-(--atum-avatar-md) place-items-center bg-(--ak-fill-quiet) text-[0.9375rem] leading-none"
              data-atum-agent-avatar
            >
              {entry.emoji}
            </span>
          ) : entry.avatarUrl ? (
            <img
              alt=""
              className="atum-avatar size-(--atum-avatar-md) object-cover"
              src={entry.avatarUrl}
            />
          ) : (
            <span
              aria-hidden="true"
              className="ak-avatar atum-avatar grid size-(--atum-avatar-md) place-items-center bg-(--ak-fill-quiet) text-[0.8125rem] leading-none font-semibold text-(--ak-ink-2)"
              data-face={entry.kind === 'app' ? 'app' : undefined}
              style={entry.kind === 'app' && entry.accent ? { background: entry.accent } : undefined}
            >
              {entry.title.slice(0, 1).toUpperCase()}
            </span>
          )}
          {/* Presence belongs to hosted rows only, and only when the
            hosted row actually reports it — never faked, never on the local
            assistant. */}
          {entry.presence === 'online' && (
            <StatusDot
              className="absolute right-0 bottom-0 size-(--atum-presence-dot) ring-2 ring-(--atum-bg-high)"
              tone="good"
            />
          )}
          {attention === 'complete' && (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-(--atum-card) text-(--atum-ok) shadow-(--atum-shadow-tile)"
              data-testid="roster-attention-complete"
            >
              <CheckCircle2 className="size-3" />
            </span>
          )}
          {attention === 'failed' && (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-(--atum-card) text-(--atum-warn) shadow-(--atum-shadow-tile)"
              data-testid="roster-attention-failed"
            >
              <AlertCircle className="size-3" />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1">
            <RosterTitle title={entry.title} />
          </span>
          {line2 && (
            <span
              className="block truncate text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)"
              data-roster-secondary
              title={entry.kind === 'app' ? `${badgeShort} · ${line2}` : undefined}
            >
              {line2}
            </span>
          )}
        </span>
        {entry.unreadCount > 0 ? (
          <span
            aria-hidden="true"
            className="grid h-(--atum-unread-pill) min-w-(--atum-unread-pill) shrink-0 place-items-center rounded-(--atum-unread-pill) bg-(--atum-ink) px-1.5 text-(length:--atum-t-label) leading-none font-semibold text-(--atum-on-accent)"
            data-roster-unread
          >
            {entry.unreadCount > 99 ? '99+' : entry.unreadCount}
          </span>
        ) : (
          Number.isFinite(activityMs) && (
            <span
              aria-hidden="true"
              className="shrink-0 text-(length:--atum-t-label) leading-(--atum-lh-label) text-(--atum-ink-faint)"
              data-roster-time
            >
              {relativeTime(activityMs)}
            </span>
          )
        )}
      </button>
    </div>
  )
}

/**
 * One of Atum's chats, nested under the pinned row: a compact, indented line
 * (title, trailing time, a small check when a background turn finished) that
 * aligns with the assistant's title column. No avatar — the identity is the
 * row above, so the list never reads as a column of duplicate contacts.
 */
function AtumChatRow({
  active,
  entry,
  finishedLabel,
  onOpen
}: {
  active: boolean
  entry: AtumRosterEntry
  finishedLabel: string
  onOpen: () => void
}) {
  const label = [entry.title, entry.preview || null, entry.unread ? finishedLabel : null].filter(Boolean).join(', ')
  const activityMs = entry.activityAt ? Date.parse(entry.activityAt) : Number.NaN

  return (
    <button
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      className="atum-row flex h-8 w-full items-center gap-2 py-1 pe-2 ps-[calc(0.5rem+var(--atum-avatar-md)+0.625rem)] text-left"
      data-current={active ? 'true' : undefined}
      data-roster-chat
      data-roster-row
      onClick={onOpen}
      type="button"
    >
      {entry.unread && (
        <span
          aria-hidden="true"
          className="grid size-3.5 shrink-0 place-items-center text-(--atum-ok)"
          data-testid="roster-attention-complete"
        >
          <CheckCircle2 className="size-3" />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-(length:--atum-t-control) leading-(--atum-lh-body) text-(--atum-ink)">
        {entry.title}
      </span>
      {Number.isFinite(activityMs) && (
        <span
          aria-hidden="true"
          className="shrink-0 text-(length:--atum-t-label) leading-(--atum-lh-label) text-(--atum-ink-faint)"
          data-roster-time
        >
          {relativeTime(activityMs)}
        </span>
      )}
    </button>
  )
}

/** Mock 1a section label: 11/600, +.06em, uppercase, faint; padding 22 20 6. */
function AtumSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="px-2 pb-1.5 pt-[1.375rem] text-(length:--atum-t-label) leading-(--atum-lh-label) font-semibold uppercase tracking-[0.06em] text-(--atum-ink-faint)"
      data-atum-section-label
    >
      {children}
    </div>
  )
}

function RosterTitle({ title }: { title: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [clipped, setClipped] = useState(false)

  const measure = useCallback(() => {
    const element = ref.current

    if (element) {
      setClipped(element.scrollWidth > element.clientWidth)
    }
  }, [])

  useResizeObserver(measure, ref)

  return (
    <Tip label={clipped ? title : null}>
      <span className="truncate text-(length:--atum-t-ui) leading-[1.2] font-medium text-(--atum-ink)" ref={ref}>
        {title}
      </span>
    </Tip>
  )
}
