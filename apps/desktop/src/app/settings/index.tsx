import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { ProtonMark } from '@/components/brand/proton-mark'
import { codiconIcon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { getHermesConfigDefaults, getHermesConfigRecord, saveHermesConfig } from '@/hermes'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import {
  Archive,
  BarChart3,
  Bell,
  Download,
  Globe,
  Info,
  Keyboard,
  KeyRound,
  Package,
  RefreshCw,
  Settings2,
  Upload,
  UserCircle,
  Wrench,
  Zap
} from '@/lib/icons'
import { $atumShellEnabled } from '@/store/atum-shell'
import { notifyError } from '@/store/notifications'

import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import { OverlayIconButton } from '../overlays/overlay-chrome'
import { OverlayMain, OverlayNav, type OverlayNavGroup, OverlaySplitLayout } from '../overlays/overlay-split-layout'
import { OverlayView } from '../overlays/overlay-view'
import { SKILLS_ROUTE } from '../routes'

import { AboutSettings } from './about-settings'
import { AppearanceSettings } from './appearance-settings'
import { AtumAccountSettings } from './atum-account-settings'
import { AtumAdvancedSettings } from './atum-advanced-settings'
import { AtumConsumerSettings } from './atum-consumer-settings'
import { AtumProtonsSettings } from './atum-protons-settings'
import { BillingSettings } from './billing'
import { ConfigSettings } from './config-settings'
import { SECTIONS } from './constants'
import { GatewaySettings } from './gateway-settings'
import { KeybindSettings } from './keybind-settings'
import { KEYS_VIEWS, KeysSettings, type KeysView } from './keys-settings'
import { NotificationsSettings } from './notifications-settings'
import { PluginsSettings } from './plugins-settings'
import { PROVIDER_VIEWS, ProvidersSettings, type ProviderView } from './providers-settings'
import { SessionsSettings } from './sessions-settings'
import type { SettingsPageProps, SettingsView as SettingsViewId } from './types'

// Exported so the tab-link guard test (atum/settings-tab-links.test.tsx) can
// assert menu destinations against the very lists `useRouteEnumParam` accepts —
// a link targeting anything else silently coerces to the default view.
export const LEGACY_SETTINGS_VIEWS: readonly SettingsViewId[] = [
  ...SECTIONS.map(s => `config:${s.id}` as SettingsViewId),
  'providers',
  'gateway',
  'keybinds',
  'keys',
  'notifications',
  'billing',
  'plugins',
  'sessions',
  'about'
]

// Account and Protons are durable destinations; retain the old Usage deep link.
export const ATUM_CONSUMER_SETTINGS_VIEWS: readonly SettingsViewId[] = ['atum:general', 'atum:advanced', 'atum:account', 'notifications', 'atum:protons', 'atum:usage', 'about']
export const ATUM_ADVANCED_SETTINGS_VIEWS: readonly SettingsViewId[] = LEGACY_SETTINGS_VIEWS.filter(view => view !== 'about')

/** Legacy-only destinations disclose the full navigation under Advanced.
 * Consumer destinations shared with the legacy tree keep their own selection. */
function deepLinkNeedsAdvanced(raw: null | string): boolean {
  return Boolean(
    raw
    && (ATUM_ADVANCED_SETTINGS_VIEWS as readonly string[]).includes(raw)
    && !(ATUM_CONSUMER_SETTINGS_VIEWS as readonly string[]).includes(raw)
  )
}

export function SettingsView({ onClose, onConfigSaved, onMainModelChanged }: SettingsPageProps) {
  const { t } = useI18n()
  const atumShell = useStore($atumShellEnabled)
  const navigate = useNavigate()
  const { hash, pathname, search } = useLocation()

  // MCP moved out of Settings into Capabilities (/skills?tab=mcp). Keep old
  // `/settings?tab=mcp` deep links working — `useRouteEnumParam` would silently
  // coerce the unknown tab to the default view otherwise. Preserve `server=` so
  // an old bookmark still lands on (and highlights) the selected server.
  useEffect(() => {
    const params = new URLSearchParams(search)

    if (params.get('tab') === 'mcp') {
      const server = params.get('server')
      const suffix = server ? `&server=${encodeURIComponent(server)}` : ''
      navigate(`${SKILLS_ROUTE}?tab=mcp${suffix}`, { replace: true })
    }
  }, [navigate, search])

  const [activeView, setActiveView] = useRouteEnumParam(
    'tab',
    atumShell ? [...ATUM_CONSUMER_SETTINGS_VIEWS, ...ATUM_ADVANCED_SETTINGS_VIEWS] : LEGACY_SETTINGS_VIEWS,
    (atumShell ? 'atum:general' : 'config:model') as SettingsViewId
  )

  // Providers subnav (Accounts vs API keys) lives in its own param so each
  // sub-view is deep-linkable and survives a refresh.
  const [providerView, setProviderView] = useRouteEnumParam<ProviderView>('pview', PROVIDER_VIEWS, 'accounts')
  const [keysView] = useRouteEnumParam<KeysView>('kview', KEYS_VIEWS, 'tools')

  // Jump to a section + its sub-view in one navigate. Two sequential setters
  // would each read the same stale `search` and the second would clobber the
  // first's `tab` — so the sub-view never opened on narrow screens.
  const openSubView = (tab: SettingsViewId, param: string, value: string, fallback: string) => {
    const params = new URLSearchParams(search)
    params.set('tab', tab)

    if (value === fallback) {
      params.delete(param)
    } else {
      params.set(param, value)
    }

    const qs = params.toString()
    navigate({ hash, pathname, search: qs ? `?${qs}` : '' }, { replace: true })
  }

  const openProviderView = (view: ProviderView) => openSubView('providers', 'pview', view, 'accounts')
  const openKeysView = (view: KeysView) => openSubView('keys', 'kview', view, 'tools')

  const importInputRef = useRef<HTMLInputElement | null>(null)

  const exportConfig = async () => {
    try {
      const cfg = await getHermesConfigRecord()
      const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'hermes-config.json'
      a.click()
      URL.revokeObjectURL(url)
      triggerHaptic('success')
    } catch (err) {
      notifyError(err, t.settings.exportFailed)
    }
  }

  const resetConfig = async () => {
    if (!window.confirm(t.settings.resetConfirm)) {
      return
    }

    try {
      await saveHermesConfig(await getHermesConfigDefaults())
      triggerHaptic('success')
      onConfigSaved?.()
    } catch (err) {
      notifyError(err, t.settings.resetFailed)
    }
  }

  const legacyNavGroups: OverlayNavGroup[] = [
    ...SECTIONS.map(s => {
      const view = `config:${s.id}` as SettingsViewId

      return {
        active: activeView === view,
        icon: s.icon,
        id: view,
        label: t.settings.sections[s.id] ?? s.label,
        onSelect: () => setActiveView(view)
      }
    }),
    {
      active: activeView === 'notifications',
      icon: Bell,
      id: 'notifications',
      label: t.settings.nav.notifications,
      onSelect: () => setActiveView('notifications')
    },
    {
      active: activeView === 'billing',
      icon: BarChart3,
      id: 'billing',
      label: t.settings.nav.billing,
      onSelect: () => setActiveView('billing')
    },
    {
      active: activeView === 'providers',
      children: [
        {
          active: activeView === 'providers' && providerView === 'accounts',
          icon: codiconIcon('account'),
          id: 'pview:accounts',
          label: t.settings.nav.providerAccounts,
          onSelect: () => openProviderView('accounts')
        },
        {
          active: activeView === 'providers' && providerView === 'keys',
          icon: KeyRound,
          id: 'pview:keys',
          label: t.settings.nav.providerApiKeys,
          onSelect: () => openProviderView('keys')
        },
        {
          active: activeView === 'providers' && providerView === 'custom-endpoints',
          icon: Globe,
          id: 'pview:custom-endpoints',
          label: t.settings.nav.providerCustomEndpoints,
          onSelect: () => openProviderView('custom-endpoints')
        }
      ],
      gapBefore: true,
      icon: Zap,
      id: 'providers',
      label: t.settings.nav.providers,
      onSelect: () => setActiveView('providers')
    },
    {
      active: activeView === 'gateway',
      icon: Globe,
      id: 'gateway',
      label: t.settings.nav.gateway,
      onSelect: () => setActiveView('gateway')
    },
    {
      active: activeView === 'keybinds',
      icon: Keyboard,
      id: 'keybinds',
      label: t.settings.nav.keybinds,
      onSelect: () => setActiveView('keybinds')
    },
    {
      active: activeView === 'keys',
      children: [
        {
          active: activeView === 'keys' && keysView === 'tools',
          icon: Wrench,
          id: 'kview:tools',
          label: t.settings.nav.keysTools,
          onSelect: () => openKeysView('tools')
        },
        {
          active: activeView === 'keys' && keysView === 'settings',
          icon: Settings2,
          id: 'kview:settings',
          label: t.settings.nav.keysSettings,
          onSelect: () => openKeysView('settings')
        }
      ],
      icon: KeyRound,
      id: 'keys',
      label: t.settings.nav.apiKeys,
      onSelect: () => setActiveView('keys')
    },
    {
      active: activeView === 'plugins',
      icon: Package,
      id: 'plugins',
      label: t.settings.nav.plugins,
      onSelect: () => setActiveView('plugins')
    },
    {
      active: activeView === 'sessions',
      icon: Archive,
      id: 'sessions',
      label: t.settings.nav.archivedChats,
      onSelect: () => setActiveView('sessions')
    },
    {
      active: activeView === 'about',
      gapBefore: true,
      icon: Info,
      id: 'about',
      label: t.settings.nav.about,
      onSelect: () => setActiveView('about')
    }
  ]

  // Advanced is a page in the everyday navigation. Opening a full Hermes
  // destination reveals its nested navigation without a separate mode toggle.
  const advancedEnabled = deepLinkNeedsAdvanced(activeView)
  const advancedActive = activeView === 'atum:advanced' || advancedEnabled

  const navGroups: OverlayNavGroup[] = atumShell
    ? [
        {
          active: activeView === 'atum:general',
          icon: Settings2,
          id: 'atum:general',
          label: t.atum.settings.general,
          onSelect: () => setActiveView('atum:general')
        },
        {
          active: activeView === 'atum:account',
          icon: UserCircle,
          id: 'atum:account',
          label: t.atum.settings.account,
          onSelect: () => setActiveView('atum:account')
        },
        {
          active: activeView === 'notifications',
          icon: Bell,
          id: 'notifications',
          label: t.atum.settings.notifications,
          onSelect: () => setActiveView('notifications')
        },
        {
          active: activeView === 'atum:protons' || activeView === 'atum:usage',
          icon: ProtonMark,
          id: 'atum:protons',
          label: t.atum.protons.title,
          onSelect: () => setActiveView('atum:protons')
        },
        {
          active: activeView === 'about',
          icon: Info,
          id: 'about',
          label: t.atum.settings.about,
          onSelect: () => setActiveView('about')
        },
        {
          active: advancedActive,
          children: advancedEnabled
            ? legacyNavGroups
                .filter(group => group.id !== 'notifications' && group.id !== 'about')
                .flatMap(group => [
                  {
                    active: group.active && !group.children?.some(child => child.active),
                    icon: group.icon,
                    id: `advanced:${group.id}`,
                    label: group.id === 'config:advanced' ? t.atum.settings.systemConfiguration : group.label,
                    onSelect: group.onSelect
                  },
                  ...(group.children ?? []).map(child => ({ ...child, id: `advanced:${child.id}` }))
                ])
            : undefined,
          gapBefore: true,
          icon: Wrench,
          id: 'atum:advanced',
          label: t.atum.settings.advanced,
          onSelect: () => setActiveView('atum:advanced')
        }
      ]
    : legacyNavGroups

  const navFooter = (
    <>
      <Tip label={t.settings.exportConfig}>
        <OverlayIconButton onClick={() => void exportConfig()}>
          <Download />
        </OverlayIconButton>
      </Tip>
      <Tip label={t.settings.importConfig}>
        <OverlayIconButton
          onClick={() => {
            triggerHaptic('open')
            importInputRef.current?.click()
          }}
        >
          <Upload />
        </OverlayIconButton>
      </Tip>
      <Tip label={t.settings.resetToDefaults}>
        <OverlayIconButton
          className="hover:text-destructive"
          onClick={() => {
            triggerHaptic('warning')
            void resetConfig()
          }}
        >
          <RefreshCw />
        </OverlayIconButton>
      </Tip>
    </>
  )

  return (
    <OverlayView chromeless={atumShell} closeLabel={t.settings.closeSettings} onClose={onClose}>
      <OverlaySplitLayout>
        <OverlayNav
          atum={atumShell ? { onBack: onClose, title: t.atum.nav.settings } : undefined}
          footer={!atumShell || advancedEnabled ? navFooter : undefined}
          groups={navGroups}
        />

        <OverlayMain className="px-0 pb-0 pt-[calc(var(--titlebar-height)+1rem)]">
          {activeView === 'atum:general' ? (
            <AtumConsumerSettings />
          ) : activeView === 'atum:advanced' ? (
            <AtumAdvancedSettings onOpen={setActiveView} />
          ) : activeView === 'atum:account' ? (
            <AtumAccountSettings />
          ) : activeView === 'atum:protons' || activeView === 'atum:usage' ? (
            <AtumProtonsSettings />
          ) : activeView === 'config:appearance' ? (
            <AppearanceSettings />
          ) : activeView === 'about' ? (
            <AboutSettings />
          ) : activeView === 'gateway' ? (
            <GatewaySettings />
          ) : activeView === 'keybinds' ? (
            <KeybindSettings />
          ) : activeView.startsWith('config:') ? (
            <ConfigSettings
              activeSectionId={activeView.slice('config:'.length)}
              importInputRef={importInputRef}
              onConfigSaved={onConfigSaved}
              onMainModelChanged={onMainModelChanged}
            />
          ) : activeView === 'providers' ? (
            <ProvidersSettings
              onClose={onClose}
              onConfigSaved={onConfigSaved}
              onMainModelChanged={onMainModelChanged}
              onViewChange={setProviderView}
              view={providerView}
            />
          ) : activeView === 'keys' ? (
            <KeysSettings view={keysView} />
          ) : activeView === 'notifications' ? (
            <NotificationsSettings />
          ) : activeView === 'billing' ? (
            <BillingSettings />
          ) : activeView === 'plugins' ? (
            <PluginsSettings />
          ) : (
            <SessionsSettings />
          )}
        </OverlayMain>
      </OverlaySplitLayout>
    </OverlayView>
  )
}

export { SettingsView as SettingsPage }
