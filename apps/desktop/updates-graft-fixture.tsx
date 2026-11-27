import './src/styles.css'
import { createRoot } from 'react-dom/client'
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
createRoot(document.getElementById('root')!).render(
  <main className="mx-auto mt-8 w-80 rounded-xl border bg-background p-5 text-foreground">
    <h1 className="mb-4 text-sm font-semibold">Atum update states</h1>
    {states.map(status => (
      <section key={status} className="flex min-h-11 items-center border-t py-1.5">
        <span className="text-sm">{status}</span>
        <SidebarUpdatePill busy={false} bridge={bridge} locale="en" openReleaseHistory={() => {}} state={{
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
