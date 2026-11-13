import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'

import { ProtonMark } from '@/components/brand/proton-mark'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { type Locale, useI18n } from '@/i18n'
import {
  ChevronLeft,
  ChevronRight,
  Command,
  DeviceDesktop,
  Eye,
  HelpCircle,
  Settings,
  ShieldLock,
  Sparkles,
  UserCircle
} from '@/lib/icons'

import type { MatrixSnapshot } from '../../shared/matrix'
import type { MatrixOwnerLocationView } from '../../shared/matrix-owner-location'
import type { MatrixPageId } from '../../shared/matrix-pages'
import { type MatrixSettingsDestination } from '../../shared/matrix-settings-revamp-copy'
import { matrixStoreHoldsCloudItems } from '../../shared/matrix-store-schedules'
import {
  type MatrixSubscriptionProvider,
  matrixSubscriptionProviderLabel
} from '../../shared/matrix-subscriptions'

import { agentStatus } from './agent-roster'
import { AppBotSettings } from './app-bots/settings'
import { openAssistantCard } from './assistant-card/store'
import { MatrixBrowserImportSettings } from './browser-import-settings'
import { MatrixCloudDeviceSettings } from './cloud-device-settings'
import { useMatrixCopy } from './copy'
import { $matrixFeedbackOpen, MatrixDesktopSettings } from './desktop-settings'
import { MatrixDisplaySettings, MatrixNotificationSettings, useMatrixDisplaySetting } from './display-settings'
import { AssistantRepair, DomainIdentity } from './domain'
import { FounderContactUs } from './founder/contact-us'
import { MatrixGoogleConnectionSettings } from './google-connection-settings'
import { HermesSetup } from './hermes-setup'
import { IgnoredPeople } from './ignored-people'
import { MatrixKeepAwakeSettings } from './keep-awake-settings'
import { MatrixKnowledgeSourcesSettings } from './knowledge-sources-settings'
import { MatrixLanguageSettings } from './language'
import { MatrixDeleteAccount, MatrixLegalSettings } from './legal-settings'
import { MatrixLoginStartupSettings } from './login-startup-settings'
import { MatrixNotificationPolicySettings } from './notification-policy-settings'
import { MatrixProfileAvatar } from './profile-avatar'
import { accountTone, OwnAvatar, ownHandleLine, useOwnName } from './rail-account'
import { primaryAgent } from './room-agent'
import { matrixRosterAgentName } from './roster-model'
import { DevicesPanel, RecoveryKeyPanel } from './security-panel'
import { useMatrixSettingsCopy } from './settings-copy'
import { SettingsRow, SettingsSection, SettingsStatus } from './settings-row'
import { $matrixSignOutOpen } from './sign-out'
import { MatrixProtonsPane } from './store/protons-pane'
import {
  matrixChatGptStateLine,
  SubscriptionChooser,
  SubscriptionConnectDialog,
  SubscriptionManageDialog,
  subscriptionProviderStatus,
  useMatrixSubscriptions
} from './subscriptions'
import { wholeProtons } from './wallet-ui'
import { workplacePageText } from './workplace'
import { workplaceDeveloperPages } from './workplace-nav'

/** Legacy ids remain accepted so current callers keep their working deep links. `subscriptions`
 * is the account Connections deep link; it never selects an assistant or native Hermes page. */
export type MatrixSettingsPane = MatrixSettingsDestination | 'apps' | 'assistant' | 'cloud' | 'subscriptions'

export function normalizeMatrixSettingsPane(pane: MatrixSettingsPane): MatrixSettingsDestination {
  if (pane === 'apps') {
    return 'connections'
  }

  if (pane === 'assistant') {
    // Existing “own model” and check-in links pointed at the old Assistant pane. Its
    // provider, repair and technical controls now live in Advanced.
    return 'advanced'
  }

  if (pane === 'subscriptions') {
    return 'connections'
  }

  return pane === 'cloud' ? 'devices' : pane
}

export function settingsLocalRuntimeControlsShown(
  cloudOnly: boolean = true
): boolean {
  return !cloudOnly
}

/**
 * Atum Kit Settings (owner-approved mockup, 2026-10-28): six pages. Account also holds Protons and
 * Privacy & security; Connections holds account subscriptions and the sources every assistant may use.
 * Every destination id still opens, so deep links keep working: one folded into a page opens that
 * page scrolled to its section. The shared destination ids and their order are unchanged.
 */
const SETTINGS_PAGES: Partial<Record<MatrixSettingsDestination, readonly MatrixSettingsDestination[]>> = {
  account: ['account', 'privacy'],
  connections: ['connections']
}

const SETTINGS_NAV: readonly { id: 'you' | 'app' | 'support'; destinations: readonly MatrixSettingsDestination[] }[] = [
  { id: 'you', destinations: ['account', 'assistants', 'connections'] },
  { id: 'app', destinations: ['general', 'help'] },
  { id: 'support', destinations: ['advanced'] }
]

/** The page a destination is drawn on. */
export function settingsPageOf(destination: MatrixSettingsDestination): MatrixSettingsDestination {
  if (destination === 'protons' || destination === 'privacy') {
    return 'account'
  }

  return destination === 'devices' ? 'connections' : destination
}

function settingsSectionsOf(page: MatrixSettingsDestination): readonly MatrixSettingsDestination[] {
  return SETTINGS_PAGES[page] ?? [page]
}

function NavIcon({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="atum-settings-nav-icon">
      {children}
    </span>
  )
}

/** One Phosphor glyph per page, as the Atum Kit Settings board draws them. */
const ICONS: Record<Exclude<MatrixSettingsDestination, 'protons'>, ReactNode> = {
  account: <UserCircle />,
  assistants: <Sparkles />,
  general: <Settings />,
  connections: <Eye />,
  devices: <DeviceDesktop />,
  privacy: <ShieldLock />,
  help: <HelpCircle />,
  advanced: <Command />
}

export function SettingsRevampNavigation({
  current,
  onSelect,
  snapshot
}: {
  current: MatrixSettingsDestination
  onSelect(destination: MatrixSettingsDestination): void
  snapshot: MatrixSnapshot
}) {
  const copy = useMatrixSettingsCopy()
  const own = useOwnName(snapshot)
  const identityLine = ownHandleLine(own)

  return (
    <nav aria-label={copy.back} className="atum-settings-nav">
      <div className="flex items-center gap-(--ak-s2) px-(--ak-s3) py-(--ak-s2)" data-matrix-settings-identity>
        <OwnAvatar className="ak-avatar" snapshot={snapshot} />
        <span className="min-w-0 flex-1">
          <span className="block truncate [font:var(--ak-t-body-strong)] text-(--ak-ink)">{own.name}</span>
          {identityLine && (
            <span className="block truncate [font:var(--ak-t-callout)] text-(--ak-ink-3)">{identityLine}</span>
          )}
        </span>
      </div>
      {/* Three quiet groups, told apart by space alone: you, the app, then help and the
          expert corner. Their names are for assistive tech; the eye needs no labels. */}
      {SETTINGS_NAV.map((group, index) => (
        <Fragment key={group.id}>
          {index > 0 && <div aria-hidden className="ak-menu-sep" role="separator" />}
          <div aria-label={copy.groups[group.id]} className="atum-settings-nav-group" role="group">
            {group.destinations.map(destination => (
              <button
                aria-current={settingsPageOf(current) === destination ? 'page' : undefined}
                className="atum-settings-nav-row"
                data-matrix-settings-pane={destination}
                key={destination}
                onClick={() => onSelect(destination)}
                type="button"
              >
                <NavIcon>{destination === 'protons' ? <ProtonMark /> : ICONS[destination]}</NavIcon>
                <span className="truncate">{copy.destinations[destination]}</span>
              </button>
            ))}
          </div>
        </Fragment>
      ))}
    </nav>
  )
}

function ThisDeviceStatus({ fail, snapshot }: { fail(): void; snapshot: MatrixSnapshot }) {
  const copy = useMatrixCopy()
  const { t } = useI18n()
  const tone = accountTone(snapshot.state)

  const status =
    snapshot.state === 'ready'
      ? copy.ready
      : snapshot.state === 'offline'
        ? copy.offline
        : snapshot.state === 'error'
          ? t.matrixShell.accountDisconnected
          : copy.connecting

  return (
    <SettingsSection>
      <SettingsRow
        control={
          <>
            <SettingsStatus role="status">
              {tone && <StatusDot tone={tone} />}
              {status}
            </SettingsStatus>
            {(snapshot.state === 'offline' || snapshot.state === 'error') && (
              <Button onClick={() => void window.atumMatrix.retry().catch(fail)} size="sm" variant="secondary">
                {copy.retry}
              </Button>
            )}
          </>
        }
        title={copy.thisMac}
      />
      {snapshot.identity && (
        <details data-matrix-technical-details>
          <summary className="text-(--atum-ink-muted)">{copy.technicalDetails}</summary>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-(length:--atum-t-caption)">
            <dt className="text-(--atum-ink-muted)">{copy.userId}</dt>
            <dd className="truncate select-text">{snapshot.identity.userId}</dd>
            <dt className="text-(--atum-ink-muted)">{copy.deviceId}</dt>
            <dd className="truncate select-text">{snapshot.identity.deviceId}</dd>
          </dl>
        </details>
      )}
    </SettingsSection>
  )
}

function AssistantRows({ onClose, snapshot }: { onClose(): void; snapshot: MatrixSnapshot }) {
  const copy = useMatrixSettingsCopy()
  const { t } = useI18n()
  const agents = snapshot.agents ?? []

  if (!agents.length) {
    return <SettingsRow className="atum-settings-row-quiet" role="status" title={copy.assistantsEmpty} />
  }

  return agents.map(agent => {
    const name = matrixRosterAgentName(agent, t.matrixShell.assistantName)

    const role = agent.isDefault ? copy.mainAssistant : agent.title

    const state = agent.ready
      ? undefined
      : agentStatus(agent) === 'agentUnavailable'
        ? copy.assistantNeedsYou
        : copy.assistantPreparing

    return (
      <button
        aria-label={`${copy.openAssistant}: ${name}`}
        className="atum-settings-row atum-settings-link atum-settings-assistant-row"
        data-matrix-settings-assistant={agent.principal}
        key={agent.principal}
        onClick={() => {
          onClose()
          // Let Settings restore its opener before the next sheet takes focus.
          requestAnimationFrame(() => openAssistantCard({ kind: 'agent', principal: agent.principal }))
        }}
        type="button"
      >
        <MatrixProfileAvatar
          avatarUrl={agent.avatarUrl}
          brand={agent.isDefault}
          className="atum-settings-assistant-avatar size-9 shrink-0 text-sm"
          id={agent.userId}
          mark={agent.mark}
          name={name}
          profile={agent.profile}
          scopeKey={`${snapshot.petScope ?? ''}/${agent.principal}`}
          target={{ kind: 'agent', principal: agent.principal }}
        />
        <span className="atum-settings-row-text">
          <span className="atum-settings-row-title">{name}</span>
          <span className="atum-settings-row-help">{[role, state].filter(Boolean).join(' · ')}</span>
        </span>
        <span aria-hidden className="atum-settings-chevron">
          ›
        </span>
      </button>
    )
  })
}

/** Who you are: your profile and public handle, then Atum's own answer balance. */
function AccountPane({
  onEditProfile,
  protons,
  snapshot
}: {
  onEditProfile?(): void
  protons?: React.ComponentProps<typeof MatrixProtonsPane>
  snapshot: MatrixSnapshot
}) {
  const copy = useMatrixSettingsCopy()
  const { locale } = useI18n()
  const own = useOwnName(snapshot)
  const handleLine = ownHandleLine(own)
  const wallet = protons?.data.state === 'ready' ? protons.data.wallet : null

  const balance = wallet
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(wholeProtons(wallet.balances.available))
    : null

  return (
    <div data-matrix-settings-destination="account">
      <SettingsSection>
        <div className="ak-row atum-settings-row atum-settings-profile">
          <OwnAvatar className="ak-avatar ak-avatar--lg" snapshot={snapshot} />
          <span className="atum-settings-row-text">
            <span className="ak-notice-title block truncate">{own.name}</span>
            {handleLine && <span className="atum-settings-row-help truncate">{handleLine}</span>}
          </span>
          {onEditProfile && snapshot.state === 'ready' && (
            <Button onClick={onEditProfile} size="sm" variant="secondary">
              {copy.editProfile}
            </Button>
          )}
        </div>
      </SettingsSection>
      <SettingsSection title={copy.howAtumAnswers}>
        <SettingsRow
          control={
            protons?.onTopUp && (
              <Button onClick={protons.onTopUp} size="sm" variant="secondary">
                {copy.topUp}
              </Button>
            )
          }
          help={balance ? copy.protonsLeft(balance) : copy.walletUnavailableHelp}
          title={copy.destinations.protons}
        />
      </SettingsSection>
    </div>
  )
}

/** Signing out and leaving: always the last thing on the Account page (Atum Kit board), below
 * every section folded into it. */
function AccountActions({ onClose, snapshot }: { onClose(): void; snapshot: MatrixSnapshot }) {
  const matrix = useMatrixCopy()

  return (
    <div className="flex items-center gap-(--ak-s2) pt-(--ak-s5)" data-matrix-settings-account-actions>
      <Button
        data-matrix-settings-sign-out
        onClick={() => {
          onClose()
          $matrixSignOutOpen.set(true)
        }}
        size="sm"
        variant="secondary"
      >
        {matrix.signOut}
      </Button>
      <MatrixDeleteAccount snapshot={snapshot} />
    </div>
  )
}

/** The one index of assistants. Each opens its own card, where everything about it lives. */
function AssistantsPane({ onClose, snapshot }: { onClose(): void; snapshot: MatrixSnapshot }) {
  const copy = useMatrixSettingsCopy()

  return (
    <div data-matrix-settings-destination="assistants">
      <p className="atum-settings-help">{copy.assistantsLead}</p>
      <SettingsSection>
        <AssistantRows onClose={onClose} snapshot={snapshot} />
      </SettingsSection>
    </div>
  )
}

/**
 * This Mac: whether it is connected, whether it stays available to your assistants, what
 * they may do on it, and what macOS allows. The list of your other devices is a matter of
 * trust, so it lives in Privacy & security beside the recovery key.
 */
function DevicesPane({ fail, snapshot }: { fail(): void; snapshot: MatrixSnapshot }) {
  const copy = useMatrixSettingsCopy()

  return (
    <div data-matrix-settings-destination="devices">
      <ThisDeviceStatus fail={fail} snapshot={snapshot} />
      <SettingsSection title={copy.availability}>
        <MatrixKeepAwakeSettings />
      </SettingsSection>
      <MatrixCloudDeviceSettings
        key={`cloud-device:${snapshot.identity?.userId ?? 'none'}:${snapshot.identity?.deviceId ?? 'none'}`}
      />
    </div>
  )
}

/** Settings › Connections: the two account-wide plans, one Connect/Manage row,
 * and the compact native flows they share. The status is the Atum account's, never one agent's. */
function SubscriptionsSettings({ scopeKey }: { scopeKey?: string }) {
  const copy = useMatrixSettingsCopy()
  const { bridge, reload, status, view } = useMatrixSubscriptions(scopeKey)
  const [dialog, setDialog] = useState<{ provider: MatrixSubscriptionProvider; kind: 'connect' | 'manage' } | null>(null)
  const [choosing, setChoosing] = useState(false)
  const { provider, state } = view
  const chatgpt = provider === 'openai-codex'
  // One line per state (subscription-view.ts). A connected OpenCode Go plan keeps its name.
  const help = chatgpt
    ? state === 'ready'
      ? `ChatGPT · ${copy.chatgptReady}`
      : (matrixChatGptStateLine(copy, state) ?? copy.subscriptionHelp)
    : matrixSubscriptionProviderLabel(provider)

  const act = () => {
    switch (view.action) {
      case 'manage':
        setDialog({ provider, kind: 'manage' })
        break
      case 'sign_in':
        setDialog({ provider: 'openai-codex', kind: 'connect' })
        break
      case 'reload':
        void reload()
        break
      default:
        setChoosing(true)
    }
  }

  const actionLabel =
    view.action === 'manage'
      ? copy.change
      : view.action === 'sign_in'
        ? copy.signIn
        : view.action === 'reload'
          ? copy.tryAgain
          : copy.connect

  return (
    <>
      <SettingsRow
        control={
          <Button
            data-matrix-subscription-action={view.action}
            disabled={!bridge}
            onClick={act}
            size="sm"
            variant="secondary"
          >
            {actionLabel}
          </Button>
        }
        data-matrix-subscription-state={state}
        data-matrix-subscriptions
        help={help}
        title={copy.yourSubscription}
      />
      <SubscriptionChooser
        onChoose={candidate => {
          setChoosing(false)
          setDialog({ provider: candidate, kind: 'connect' })
        }}
        onOpenChange={setChoosing}
        open={choosing}
        providers={status?.providers}
      />
      {dialog && (
        <SubscriptionConnectDialog
          onClose={() => setDialog(null)}
          onConnected={() => void reload()}
          open={dialog.kind === 'connect'}
          provider={dialog.provider}
        />
      )}
      {dialog && (
        <SubscriptionManageDialog
          onChanged={() => void reload()}
          onClose={() => setDialog(null)}
          onReconnect={() => setDialog({ provider: dialog.provider, kind: 'connect' })}
          open={dialog.kind === 'manage'}
          provider={dialog.provider}
          status={subscriptionProviderStatus(status, dialog.provider)}
          view={view}
        />
      )}
    </>
  )
}

/** Account Connections: subscriptions first, then the sources every assistant may use. */
function ConnectionsPane({ snapshot }: { snapshot: MatrixSnapshot }) {
  const copy = useMatrixSettingsCopy()

  return (
    <div data-matrix-settings-destination="connections">
      <SettingsSection data-matrix-settings-section="subscriptions" title={copy.subscriptions}>
        <SubscriptionsSettings
          scopeKey={snapshot.identity ? `${snapshot.identity.userId}:${snapshot.identity.deviceId}` : 'signed-out'}
        />
      </SettingsSection>
      <MatrixKnowledgeSourcesSettings
        // Account-wide: the open chat or assistant never remounts (or re-fences) these switches.
        key={`knowledge-sources:${snapshot.petScope ?? snapshot.identity?.userId ?? 'none'}`}
      />
      {snapshot.identity ? (
        <MatrixGoogleConnectionSettings
          active={snapshot.state === 'ready'}
          assistant={snapshot.googleAssistant}
          identity={snapshot.identity}
          key={`google:${snapshot.identity.userId}:${snapshot.identity.deviceId}`}
        />
      ) : (
        <SettingsSection title={copy.google}>
          <SettingsRow className="atum-settings-row-quiet" role="status" title={copy.notAvailableYet} />
        </SettingsSection>
      )}
      {snapshot.identity && (
        <MatrixBrowserImportSettings
          key={`browser-import:${snapshot.identity.userId}:${snapshot.identity.deviceId}`}
          snapshot={snapshot}
        />
      )}
      <SettingsSection title={copy.apps}>
        <AppBotSettings snapshot={snapshot} />
      </SettingsSection>
    </div>
  )
}

function ActivitySetting({ snapshot }: { snapshot: MatrixSnapshot }) {
  const copy = useMatrixSettingsCopy()
  const setting = useMatrixDisplaySetting(snapshot, 'shareActivity')
  const value = snapshot.displayPreferences?.shareActivity?.value

  return (
    <SettingsSection title={copy.activity}>
      {snapshot.identity && snapshot.displayPreferences?.shareActivity ? (
        <div className="atum-settings-item">
          <SettingsRow
            control={
              <Switch
                aria-label={copy.shareActivity}
                checked={value ?? true}
                disabled={setting.disabled}
                onCheckedChange={next => void setting.change(next)}
              />
            }
            help={copy.shareActivityHelp}
            title={copy.shareActivity}
          />
          {(setting.notice || setting.readonly) && (
            <NoticeBand role="status" tone="notice">
              {setting.notice ? setting.copy[setting.notice] : setting.copy.readonly}
            </NoticeBand>
          )}
        </div>
      ) : (
        <SettingsRow className="atum-settings-row-quiet" role="status" title={copy.notAvailableYet} />
      )}
    </SettingsSection>
  )
}

/**
 * 0333: one row and one switch for the owner's coarse location. The platform stores the city,
 * region and country from the owner's own authenticated connection; this Mac only reads it back
 * and turns reporting off. Off clears the value at the platform, and assistants fall back to the
 * time zone. No modal and no consent wall: the row starts on, and one tap is the whole off switch.
 * An older host without the bridge shows no row at all.
 */
const ownerLocationCopy: Record<Locale, {
  title: string
  on: (place: string) => string
  onNoPlace: string
  off: string
  failed: string
}> = {
  en: {
    title: 'Approximate location',
    on: place => `Around ${place}. Used to make answers fit your day.`,
    onNoPlace: 'On. Your next visit sets it from your connection.',
    off: 'Off. Assistants use your time zone only.',
    failed: 'Couldn’t read your location setting.'
  },
  vi: {
    title: 'Vị trí gần đúng',
    on: place => `Ở ${place}. Dùng để câu trả lời hợp với ngày của bạn.`,
    onNoPlace: 'Đang bật. Lần truy cập tiếp theo sẽ đặt vị trí từ kết nối của bạn.',
    off: 'Đang tắt. Trợ lý chỉ dùng múi giờ của bạn.',
    failed: 'Không đọc được cài đặt vị trí.'
  },
  zh: {
    title: '大致位置',
    on: place => `在${place}附近。用于让回答更贴合你的一天。`,
    onNoPlace: '已开启。下次连接时会根据你的网络设置位置。',
    off: '已关闭。助手只使用你的时区。',
    failed: '无法读取位置设置。'
  },
  'zh-hant': {
    title: '大致位置',
    on: place => `在${place}附近。用於讓回答更貼近你的一天。`,
    onNoPlace: '已開啟。下次連線時會根據你的網路設定位置。',
    off: '已關閉。助理只使用你的時區。',
    failed: '無法讀取位置設定。'
  },
  ja: {
    title: 'おおよその位置',
    on: place => `${place} 周辺。一日に合った回答のために使います。`,
    onNoPlace: 'オンです。次回の接続時に位置が設定されます。',
    off: 'オフです。アシスタントはタイムゾーンだけを使います。',
    failed: '位置設定を読み取れませんでした。'
  }
}

function ownerLocationPlace(view: MatrixOwnerLocationView, locale: Locale): string {
  const country = view.country
  let countryName = country

  if (country) {
    // The owner's UI language names the country: Vietnamese reads "Việt Nam", not "Vietnam".
    try { countryName = new Intl.DisplayNames([locale], { type: 'region' }).of(country) ?? country } catch { countryName = country }
  }

  return [view.city ?? view.region, countryName].filter(Boolean).join(', ')
}

function OwnerLocationSetting() {
  const { locale } = useI18n()
  const bridge = window.atumMatrix?.ownerLocation
  const copy = ownerLocationCopy[locale] ?? ownerLocationCopy.en
  const [view, setView] = useState<MatrixOwnerLocationView | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!bridge) {
      return
    }

    let live = true

    void bridge.read().then(
      next => {
        if (live) {
          setView(next)
        }
      },
      () => {
        if (live) {
          setFailed(true)
        }
      }
    )

    return () => { live = false }
  }, [bridge])

  if (!bridge) {
    return null
  }

  const place = view ? ownerLocationPlace(view, locale) : ''

  const help = failed
    ? copy.failed
    : !view ? undefined : view.enabled ? (place ? copy.on(place) : copy.onNoPlace) : copy.off

  const change = (next: boolean) => {
    if (!view || busy) {
      return
    }

    setBusy(true)
    setFailed(false)
    void bridge.setEnabled(next).then(
      value => { setView(value); setBusy(false) },
      () => { setBusy(false); setFailed(true) }
    )
  }

  return (
    <SettingsSection title={copy.title}>
      <SettingsRow
        control={
          <Switch
            aria-busy={view ? undefined : true}
            aria-label={copy.title}
            // Until the platform read lands the switch is disabled and must not claim "on".
            checked={view ? view.enabled : false}
            disabled={!view || busy}
            onCheckedChange={next => void change(next)}
          />
        }
        help={help}
        title={copy.title}
      />
    </SettingsSection>
  )
}

const peopleDiscoveryCopy: Record<Locale, { title: string; help: string; failed: string }> = {
  en: { title: 'Let people find me by name and email', help: 'People can find you to start a chat.', failed: 'Couldn’t update this setting.' },
  vi: { title: 'Cho phép tìm tôi bằng tên và email', help: 'Mọi người có thể tìm bạn để bắt đầu trò chuyện.', failed: 'Không cập nhật được cài đặt này.' },
  ja: { title: '名前とメールで自分を見つけられるようにする', help: 'ほかの人があなたを見つけてチャットを始められます。', failed: 'この設定を更新できませんでした。' },
  zh: { title: '允许他人通过姓名和邮箱找到我', help: '其他人可以找到你并发起聊天。', failed: '无法更新此设置。' },
  'zh-hant': { title: '允許他人透過姓名和電子郵件找到我', help: '其他人可以找到你並開始聊天。', failed: '無法更新此設定。' }
}

function PeopleDiscoverySetting() {
  const { locale } = useI18n()
  const copy = peopleDiscoveryCopy[locale] ?? peopleDiscoveryCopy.en
  const bridge = window.atumMatrix?.people
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!bridge) {
      return
    }
    let live = true
    void bridge.privacy().then(result => {
      if (!live) {
        return
      }
      if (result.ok) {
        setEnabled(result.enabled)
      } else {
        setFailed(true)
      }
    }, () => {
      if (live) {
        setFailed(true)
      }
    })
    return () => { live = false }
  }, [bridge])

  if (!bridge) {
    return null
  }

  const change = (next: boolean) => {
    if (enabled === null || busy) {
      return
    }
    const previous = enabled
    setEnabled(next)
    setBusy(true)
    setFailed(false)
    void bridge.setPrivacy(next).then(result => {
      if (result.ok) {
        setEnabled(result.enabled)
      } else {
        setEnabled(previous)
        setFailed(true)
      }
      setBusy(false)
    }, () => {
      setEnabled(previous)
      setBusy(false)
      setFailed(true)
    })
  }

  return (
    <SettingsSection>
      <SettingsRow
        control={<Switch aria-label={copy.title} checked={enabled ?? false} disabled={enabled === null || busy}
          onCheckedChange={change} />}
        help={failed ? copy.failed : copy.help}
        title={copy.title}
      />
    </SettingsSection>
  )
}

/**
 * Privacy & security, folded into Account. Your devices first (Atum Kit board: Account ›
 * Devices), then what is true for everyone: where chats are kept and that end-to-end
 * encryption is opt-in per chat (0.20: chats are plain by default), what Atum remembers, what
 * others see, the owner's coarse location, and the people you ignore. The recovery key comes
 * last, for the chats a person chooses to encrypt: the owner's decision is that nobody is asked
 * to keep a key for messages that are not encrypted. It and the devices lead only while this
 * Mac cannot open the assistant until the key is entered (`recovery_required`), the one time
 * the recovery and device-review links need them in view. The groups are keyed, so moving one
 * never remounts a panel in the middle of a step.
 */
function PrivacyPane({ snapshot }: { snapshot: MatrixSnapshot }) {
  const copy = useMatrixSettingsCopy()
  const unlock = snapshot.readiness?.code === 'recovery_required'

  const recovery = snapshot.identity ? (
    <SettingsSection help={copy.recoveryHelp} key="recovery" title={copy.encryptedMessages}>
      <RecoveryKeyPanel key={`recovery:${snapshot.identity.userId}:${snapshot.identity.deviceId}`} snapshot={snapshot} />
    </SettingsSection>
  ) : null

  // Your devices come first, right under how Atum answers (Atum Kit board: Account › Devices).
  const devices = snapshot.identity ? (
    <DevicesPanel key={`devices:${snapshot.identity.userId}:${snapshot.identity.deviceId}`} snapshot={snapshot} />
  ) : (
    <SettingsSection key="devices" title={copy.otherDevices}>
      <SettingsRow className="atum-settings-row-quiet" role="status" title={copy.notAvailableYet} />
    </SettingsSection>
  )

  const everyone = [
    <PeopleDiscoverySetting key="people-discovery" />,
    <SettingsSection foot={copy.encryptionDetail} key="chats" title={copy.chats}>
      <SettingsRow help={copy.chatsStoredHelp} title={copy.chatsStored} />
    </SettingsSection>,
    <OwnerLocationSetting key="location" />,
    // Memory is not a setting yet: one honest row and the disclosure, never a switch or a
    // "Forget" button that does nothing.
    <SettingsSection foot={copy.memoryDisclosure} key="memory" title={copy.memory}>
      <SettingsRow
        className="atum-settings-row-quiet"
        control={<SettingsStatus>{copy.notAvailableYet}</SettingsStatus>}
        help={copy.remembersHelp}
        role="status"
        title={copy.remembers}
      />
    </SettingsSection>,
    <ActivitySetting key="activity" snapshot={snapshot} />,
    snapshot.identity ? <IgnoredPeople key="ignored" snapshot={snapshot} /> : null
  ]

  return (
    <div data-matrix-settings-destination="privacy">
      {unlock ? [recovery, devices, ...everyone] : [devices, ...everyone, recovery]}
    </div>
  )
}

/** How Atum looks, speaks, notifies and starts on this Mac. */
function GeneralPane({ snapshot }: { snapshot: MatrixSnapshot }) {
  const settings = useMatrixSettingsCopy()
  const { t } = useI18n()

  return (
    <div data-matrix-settings-destination="general">
      <SettingsSection title={settings.look}>
        <MatrixDisplaySettings snapshot={snapshot} />
        <SettingsRow
          control={<MatrixLanguageSettings quiet snapshot={snapshot} />}
          title={t.matrixShell.settingsLanguage}
        />
      </SettingsSection>
      <SettingsSection title={settings.notifications}>
        <MatrixNotificationSettings snapshot={snapshot} />
        <MatrixNotificationPolicySettings
          key={`${snapshot.identity?.userId ?? 'signed-out'}:${snapshot.identity?.deviceId ?? ''}`}
          snapshot={snapshot}
        />
      </SettingsSection>
      <SettingsSection title={settings.startupSection}>
        <MatrixLoginStartupSettings />
      </SettingsSection>
    </div>
  )
}

/** Help: the version and its update, reaching a person, sharing and feedback, the fine print. */
function HelpPane({ onClose, snapshot }: { onClose(): void; snapshot: MatrixSnapshot }) {
  return (
    <div data-matrix-settings-destination="help">
      <MatrixDesktopSettings
        onOpenFeedback={() => {
          onClose()
          $matrixFeedbackOpen.set(true)
        }}
      />
      {snapshot.identity && <FounderContactUs onClose={onClose} snapshot={snapshot} />}
      <MatrixLegalSettings />
    </div>
  )
}

function ProtonsPane({ protons }: { protons?: React.ComponentProps<typeof MatrixProtonsPane> }) {
  const copy = useMatrixSettingsCopy()

  return protons ? (
    <div data-matrix-settings-destination="protons">
      <MatrixProtonsPane {...protons} />
    </div>
  ) : (
    <div data-matrix-settings-destination="protons">
      <SettingsSection>
        <SettingsRow
          className="atum-settings-row-quiet"
          help={copy.walletUnavailableHelp}
          role="status"
          title={copy.walletUnavailable}
        />
      </SettingsSection>
    </div>
  )
}

const ADVANCED_SELECT =
  '-me-2 h-7 w-auto min-w-0 gap-1 border-transparent! bg-transparent! px-2 text-(--atum-ink) shadow-none! hover:bg-(--atum-hover)! data-[state=open]:bg-(--atum-hover)!'

/**
 * The old Advanced pane also owned keep-awake. That control now has one home in
 * Devices, so the revamp composes the remaining existing strict-trust and native page
 * handlers here instead of mounting a second live switch.
 */
function AdvancedTools({
  children,
  cloudOnly,
  onOpenPage,
  snapshot
}: {
  children: ReactNode
  cloudOnly?: boolean
  onOpenPage?(page: MatrixPageId, agentPrincipal: string): void
  snapshot: MatrixSnapshot
}) {
  const copy = useMatrixSettingsCopy()
  const { locale, t } = useI18n()
  const agents = snapshot.agents ?? []
  const pageAgents = agents.filter(agent => workplaceDeveloperPages(agent, cloudOnly).length > 0)
  const fallback = primaryAgent(snapshot)?.principal ?? agents[0]?.principal
  const [chosen, setChosen] = useState<string | undefined>(fallback)
  const principal = pageAgents.some(agent => agent.principal === chosen) ? chosen : pageAgents[0]?.principal
  const developerPages = workplaceDeveloperPages(agents.find(agent => agent.principal === principal), cloudOnly)

  useEffect(() => {
    if (chosen !== principal) {
      setChosen(principal)
    }
  }, [chosen, principal])

  const anyPages = pageAgents.length > 0 && Boolean(onOpenPage && window.atumMatrix?.pages)
  const pages = Boolean(anyPages && principal && developerPages.length)

  const pageRow = (page: MatrixPageId) => {
    const words = workplacePageText(page, locale)

    return (
      <button
        className="atum-settings-row atum-settings-link"
        data-matrix-advanced-page={page}
        key={page}
        onClick={() => {
          if (principal) {
            onOpenPage?.(page, principal)
          }
        }}
        type="button"
      >
        <span className="atum-settings-row-text">
          <span className="atum-settings-row-title">{words.title}</span>
          <span className="atum-settings-row-help">{words.help}</span>
        </span>
        <ChevronRight aria-hidden className="atum-settings-chevron" />
      </button>
    )
  }

  return (
    <div data-matrix-advanced-settings>
      {anyPages && agents.length > 1 && (
        <SettingsSection>
          <SettingsRow
            control={
              <Select onValueChange={setChosen} value={principal}>
                <SelectTrigger aria-label={copy.destinations.assistants} className={ADVANCED_SELECT} size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {pageAgents.map(agent => (
                    <SelectItem key={agent.principal} value={agent.principal}>
                      {matrixRosterAgentName(agent, t.matrixShell.assistantName)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
            title={copy.destinations.assistants}
          />
        </SettingsSection>
      )}
      {children}
      {pages && (
        <SettingsSection data-matrix-advanced-pages title={copy.expertTools}>
          {developerPages.map(pageRow)}
        </SettingsSection>
      )}
    </div>
  )
}

/** The expert corner: which model answers, repair, technical checks, developer pages. */
function AdvancedPane({
  cloudOnly = true,
  onOpenAdvancedPage,
  snapshot,
  visible
}: {
  cloudOnly?: boolean
  onOpenAdvancedPage?(page: MatrixPageId, agentPrincipal: string): void
  snapshot: MatrixSnapshot
  visible: boolean
}) {
  const copy = useMatrixSettingsCopy()
  const assistantAvailable = Boolean(snapshot.domainEnabled)
  const localRuntime = settingsLocalRuntimeControlsShown(cloudOnly)

  return (
    <div data-matrix-settings-destination="advanced" hidden={!visible}>
      <AdvancedTools cloudOnly={cloudOnly} onOpenPage={onOpenAdvancedPage} snapshot={snapshot}>
          {assistantAvailable ? (
            <>
              {localRuntime && (
                <SettingsSection title={copy.model}>
                  <HermesSetup
                    atumModel={snapshot.atumModel}
                    ownModel={snapshot.ownModel}
                    paidItems={matrixStoreHoldsCloudItems(
                      snapshot.store?.entitlements ?? [],
                      snapshot.agents?.find(agent => agent.isDefault)?.assistantId
                    )}
                    showCurrentMode={false}
                    status={snapshot.hermes}
                    visible={visible}
                  />
                </SettingsSection>
              )}
              <SettingsSection title={copy.repair}>
                {localRuntime && <AssistantRepair snapshot={snapshot} />}
                <DomainIdentity visible={visible} />
              </SettingsSection>
            </>
          ) : localRuntime ? (
            <SettingsSection title={copy.model}>
              <SettingsRow className="atum-settings-row-quiet" role="status" title={copy.notAvailableYet} />
            </SettingsSection>
          ) : null}
      </AdvancedTools>
    </div>
  )
}

export type MatrixSettingsProtons = React.ComponentProps<typeof MatrixProtonsPane>

export function SettingsRevampPane({
  cloudOnly = true,
  current,
  fail,
  onClose,
  onEditProfile,
  onOpenAdvancedPage,
  open,
  protons,
  snapshot
}: {
  cloudOnly?: boolean
  current: MatrixSettingsDestination
  fail(): void
  onClose(): void
  onEditProfile?(): void
  onOpenAdvancedPage?(page: MatrixPageId, agentPrincipal: string): void
  open: boolean
  protons?: MatrixSettingsProtons
  snapshot: MatrixSnapshot
}) {
  const page = settingsPageOf(current)
  const sections = settingsSectionsOf(page)
  const anchor = useRef<HTMLElement | null>(null)

  // A destination folded into a page (a link to Protons, Privacy or This Mac) lands on its section.
  useEffect(() => {
    if (open && current !== page) {
      anchor.current?.scrollIntoView?.({ block: 'start' })
    }
  }, [current, open, page])

  const body = (destination: MatrixSettingsDestination) => {
    switch (destination) {
      case 'account':
        return <AccountPane onEditProfile={onEditProfile} protons={protons} snapshot={snapshot} />

      case 'assistants':
        return <AssistantsPane onClose={onClose} snapshot={snapshot} />

      case 'protons':
        return <ProtonsPane protons={protons} />

      case 'general':
        return <GeneralPane snapshot={snapshot} />

      case 'connections':
        return <ConnectionsPane snapshot={snapshot} />

      case 'devices':
        return <DevicesPane fail={fail} snapshot={snapshot} />

      case 'privacy':
        return <PrivacyPane snapshot={snapshot} />

      case 'help':
        return <HelpPane onClose={onClose} snapshot={snapshot} />

      default:
        return null
    }
  }

  return (
    <>
      {open &&
        page !== 'advanced' &&
        sections.map((destination, index) => (
          <section
            className={index > 0 ? 'atum-settings-section' : undefined}
            data-matrix-settings-section={destination}
            key={destination}
            ref={destination === current && index > 0 ? anchor : undefined}
          >
            {index > 0 && <SettingsSectionTitle destination={destination} />}
            {body(destination)}
          </section>
        ))}
      {open && page === 'account' && <AccountActions onClose={onClose} snapshot={snapshot} />}
      {/* Provider setup stays mounted while the sheet is closed, preserving the old pane's
          in-flight state. Its secret fields still clear because visible becomes false. */}
      <AdvancedPane
        cloudOnly={cloudOnly}
        onOpenAdvancedPage={onOpenAdvancedPage}
        snapshot={snapshot}
        visible={open && page === 'advanced'}
      />
    </>
  )
}

function SettingsSectionTitle({ destination }: { destination: MatrixSettingsDestination }) {
  const copy = useMatrixSettingsCopy()

  // The folded page's own sections carry small labels (Atum Kit board), so its name is for
  // assistive tech and heading navigation only; a second, larger heading would stack two titles.
  return <h3 className="sr-only">{copy.destinations[destination]}</h3>
}

export function SettingsRevampBack({ onClick }: { onClick(): void }) {
  const copy = useMatrixSettingsCopy()

  return (
    <button className="atum-settings-back" data-matrix-settings-back onClick={onClick} type="button">
      <ChevronLeft aria-hidden />
      {copy.back}
    </button>
  )
}

export function SettingsRevampTitle({ destination }: { destination: MatrixSettingsDestination }) {
  const copy = useMatrixSettingsCopy()

  return <>{copy.destinations[settingsPageOf(destination)]}</>
}
