import './src/styles.css'

import { createRoot } from 'react-dom/client'

import { AtumShellFrame } from './src/app/atum/shell-frame'
import { TooltipProvider } from './src/components/ui/tooltip'
import { I18nProvider } from './src/i18n'
import type { MatrixSnapshot } from './shared/matrix'
import { $matrixDesktopServices } from './src/matrix/desktop-services'
import { MatrixUpdateFooter } from './src/matrix/desktop-settings'
import { MatrixRailAccount } from './src/matrix/rail-account'

import { SidebarUpdatePill } from './src/matrix/updates/sidebar-pill'
import { createInitialDesktopUpdateState } from './vendor/t3-updates/apps/desktop/src/updates/updateMachine'
import type { DesktopUpdateState } from './vendor/t3-updates/packages/contracts/src/desktopUpdates'

const theme = new URLSearchParams(location.search).get('theme') ?? 'light'
document.documentElement.classList.toggle('dark', theme === 'dark')
const initial = createInitialDesktopUpdateState('1.0.0', {
  hostArch: 'arm64', appArch: 'arm64', runningUnderArm64Translation: false
}, 'latest')
const states: DesktopUpdateState['status'][] = ['disabled', 'idle', 'checking', 'up-to-date', 'available', 'downloading', 'downloaded', 'error']
const bridge = { checkUpdates: async () => true, downloadUpdate: async () => true, restart: async () => true }
const root = createRoot(document.getElementById('root')!)
const rail = new URLSearchParams(location.search).get('rail')
if (rail) {
  const snapshot = { state: 'ready', identity: { userId: '@account:fixture', deviceId: 'fixture' }, rooms: [], messages: [] } as MatrixSnapshot
  window.atumDesktopServices = bridge as typeof window.atumDesktopServices
  $matrixDesktopServices.set({
    desktopUpdate: { ...initial, status: 'downloaded', enabled: true, availableVersion: '1.1.0', downloadedVersion: '1.1.0' },
    version: '1.0.0', busy: false, reporting: { configured: false }
  } as Parameters<typeof $matrixDesktopServices.set>[0])
  root.render(
    <I18nProvider initialLocale="en"><TooltipProvider>
      <AtumShellFrame compact={false} main={<div />} navigation={
        <div className="atum-rail-foot" data-matrix-rail-foot>
          <MatrixUpdateFooter />
          <MatrixRailAccount open={false} snapshot={snapshot} fail={() => {}} onOpenChange={() => {}} onOpenSettings={() => {}} />
        </div>
      } roster={<div data-atum-roster />} rosterDrawerOpen={false} rosterDrawerLabel="Chats" rosterDrawerCloseLabel="Close"
      onCloseRosterDrawer={() => {}} sidebarShowing={rail === 'expanded'} screen="chat"
      workspaceOpen={false} workspaceInSplit={false} workspaceOverFrame={false} workspacePercent={40} />
    </TooltipProvider></I18nProvider>
  )
} else root.render(
  <main className="mx-auto mt-8 w-80 rounded-xl border bg-background p-5 text-foreground">
    <h1 className="mb-4 text-sm font-semibold">Atum update states</h1>
    {states.map(status => (
      <section className="flex min-h-11 items-center border-t py-1.5" key={status}>
        <span className="text-sm">{status}</span>
        <SidebarUpdatePill bridge={bridge} busy={false} locale="en" openReleaseHistory={() => {}} state={{
          ...initial, status, enabled: status !== 'disabled',
          availableVersion: ['available', 'downloaded', 'downloading'].includes(status) ? '1.1.0' : null,
          downloadedVersion: status === 'downloaded' ? '1.1.0' : null,
          downloadPercent: status === 'downloading' ? 64 : null,
          errorContext: status === 'error' ? 'check' : null
        }} />
      </section>
    ))}
  </main>
)
