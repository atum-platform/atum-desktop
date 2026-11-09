import '../styles.css'

import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { type ArtifactsPageClient, ArtifactsPresentation } from '@/app/artifacts/presentation'
import { type CronPageClient, CronPresentation } from '@/app/cron/presentation'
import { type SkillsPageClient, SkillsPresentation } from '@/app/skills/presentation'
import { NotificationStack } from '@/components/notifications'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { I18nProvider, normalizeLocale, useI18n } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import type { SessionInfo, SessionMessage } from '@/types/hermes'

import type { MatrixAuxiliaryClient } from '../../shared/matrix-auxiliary-settings'
import type { MatrixComputerUseClient } from '../../shared/matrix-computer-use'
import type { MatrixComputerUseGrantClient } from '../../shared/matrix-computer-use-grant'
import {
  MATRIX_PAGE_IDS,
  type MatrixHermesPagesBridge,
  matrixHubSkillName,
  type MatrixPagesContext
} from '../../shared/matrix-pages'
import type { MatrixRuntimeSettingsClient } from '../../shared/matrix-runtime-settings'
import type { MatrixToolSettingsClient } from '../../shared/matrix-tool-settings'
import type { MatrixVoiceSettingsClient } from '../../shared/matrix-voice-settings'
import { applyMatrixPalette } from '../matrix/appearance'
import { installMatrixDiagnostics } from '../matrix/diagnostics'

import { MatrixCommandCenter } from './command-center'
import { createMatrixCommandCenterClient } from './command-center-client'
import { createMatrixCommandCenterOpsClient } from './command-center-ops-client'
import { MatrixConnections } from './connections'
import { connectionsCopy } from './connections-copy'
import { pagesCopy } from './copy'
import { createMatrixCuratorClient } from './curator-client'
import { createMatrixDebugClient } from './debug-share-client'
import { createMatrixMcpSettingsClient } from './mcp-client'
import { MatrixMcpSettings } from './mcp-settings'
import { MatrixProvidersSettings } from './providers'
import { createMatrixProviderSettingsClient } from './providers-client'
import { MatrixRuntimeSettings } from './runtime-settings'
import { MatrixSkillsHub, type MatrixSkillsHubClient } from './skills-hub'
import { MatrixStarmap } from './starmap'
import { createMatrixStarmapClient } from './starmap-client'

installMatrixDiagnostics()

interface PagesWindow extends Window {
  atumHermesPages?: MatrixHermesPagesBridge
}

function bridge(): MatrixHermesPagesBridge {
  const candidate = (window as PagesWindow).atumHermesPages

  if (!candidate) {
    throw new Error('The local management pages bridge is unavailable')
  }

  return candidate
}

function isContextError(value: MatrixPagesContext | { error: string }): value is { error: string } {
  return 'error' in value
}

function PageAppearance({ appearance }: { appearance: 'dark' | 'light' }) {
  useEffect(() => applyMatrixPalette(appearance), [appearance])

  return null
}

function api<T>(path: string, method: 'DELETE' | 'GET' | 'POST' | 'PUT' = 'GET', body?: unknown): Promise<T> {
  return bridge().api<T>({ ...(body === undefined ? {} : { body }), method, path })
}

function cronClient(): CronPageClient {
  return {
    create: body => api('/api/cron/jobs', 'POST', body),
    delete: jobId => api(`/api/cron/jobs/${encodeURIComponent(jobId)}`, 'DELETE'),
    getJobs: () => api('/api/cron/jobs'),
    getRuns: async jobId => {
      const result = await api<{ runs: SessionInfo[] }>(`/api/cron/jobs/${encodeURIComponent(jobId)}/runs?limit=20`)

      return result.runs ?? []
    },
    pause: jobId => api(`/api/cron/jobs/${encodeURIComponent(jobId)}/pause`, 'POST'),
    resume: jobId => api(`/api/cron/jobs/${encodeURIComponent(jobId)}/resume`, 'POST'),
    trigger: jobId => api(`/api/cron/jobs/${encodeURIComponent(jobId)}/trigger`, 'POST'),
    update: (jobId, updates) => api(`/api/cron/jobs/${encodeURIComponent(jobId)}`, 'PUT', { updates })
  }
}

function artifactsClient(): ArtifactsPageClient {
  return {
    getSessionMessages: sessionId => api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`),
    listSessions: () => api('/api/profiles/sessions?limit=30&offset=0&min_messages=1')
  }
}

function skillsClient(): SkillsPageClient {
  return {
    getSkills: () => api('/api/skills'),
    getToolsets: () => api('/api/tools/toolsets'),
    getLearnedSkill: name => api(`/api/learning/node?id=${encodeURIComponent(name)}`),
    editLearnedSkill: (id, content) => api('/api/learning/node', 'PUT', { id, content }),
    archiveLearnedSkill: id => api('/api/learning/node', 'DELETE', { id }),
    toggleSkill: (name, enabled) => api('/api/skills/toggle', 'PUT', { name, enabled }),
    toggleToolset: (name, enabled) => api(`/api/tools/toolsets/${encodeURIComponent(name)}`, 'PUT', { enabled })
  }
}

function hubClient(): MatrixSkillsHubClient {
  return {
    getSources: () => api('/api/skills/hub/sources'),
    search: (query, source) => api(`/api/skills/hub/search?${new URLSearchParams({ q: query, source, limit: '20' })}`),
    preview: identifier => api(`/api/skills/hub/preview?${new URLSearchParams({ identifier })}`),
    scan: identifier => api(`/api/skills/hub/scan?${new URLSearchParams({ identifier })}`),
    install: identifier => api('/api/skills/hub/install', 'POST', { identifier }),
    uninstall: name => api('/api/skills/hub/uninstall', 'POST', { name, archive: true }),
    update: name => api('/api/skills/hub/update-safe', 'POST', name === undefined ? { all: true } : { name }),
    status: name => api(`/api/actions/${encodeURIComponent(name)}/status?lines=200`)
  }
}

function runtimeClient(): MatrixRuntimeSettingsClient {
  return {
    snapshot: () => api('/api/runtime/snapshot'),
    setModel: (provider, model) => api('/api/model/set', 'POST', { scope: 'main', provider, model }),
    setMemory: provider => api('/api/memory/provider', 'PUT', { provider })
  }
}

function toolSettingsClient(): MatrixToolSettingsClient {
  return {
    snapshot: () => api('/api/tool-settings/snapshot'),
    set: (field, value) => api('/api/tool-settings/set', 'POST', { field, value })
  }
}

function auxiliaryClient(): MatrixAuxiliaryClient {
  return {
    snapshot: () => api('/api/auxiliary-settings/snapshot'),
    set: (task, provider, model) => api('/api/auxiliary-settings/set', 'POST', { task, provider, model })
  }
}

function computerUseClient(): MatrixComputerUseClient {
  return { status: () => api('/api/tools/computer-use/status') }
}

function computerUseGrantClient(): MatrixComputerUseGrantClient {
  return {
    start: () => api('/api/tools/computer-use/permissions/grant', 'POST'),
    operationStatus: operationId => api(`/api/tools/computer-use/permissions/grants/${encodeURIComponent(operationId)}`)
  }
}

function voiceSettingsClient(): MatrixVoiceSettingsClient {
  return {
    snapshot: () => api('/api/voice-settings/snapshot'),
    set: (field, value) => api('/api/voice-settings/set', 'POST', { field, value })
  }
}

function messageText(message: SessionMessage): string {
  if (typeof message.content === 'string') {
    return message.content
  }

  if (typeof message.text === 'string') {
    return message.text
  }

  return ''
}

function SessionDialog({
  onOpenChange,
  sessionId
}: {
  onOpenChange: (open: boolean) => void
  sessionId: null | string
}) {
  const { locale, t } = useI18n()
  const c = pagesCopy[locale]
  const [messages, setMessages] = useState<SessionMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionId) {
      return
    }

    let active = true
    setMessages(null)
    setError(null)
    void api<{ messages: SessionMessage[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
      .then(result => {
        if (active) {
          setMessages(result.messages)
        }
      })
      .catch(reason => {
        if (active) {
          setError(reason instanceof Error ? reason.message : 'Could not load this session')
        }
      })

    return () => {
      active = false
    }
  }, [sessionId])

  return (
    <Dialog onOpenChange={onOpenChange} open={Boolean(sessionId)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{c.session}</DialogTitle>
          <DialogDescription>{c.readOnly}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive">{c.failed}</p>
        ) : !messages ? (
          <PageLoader label={t.common.loading} />
        ) : (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-2">
            {messages.map((message, index) => (
              <article className="rounded-md bg-muted p-3 text-sm" key={`${message.timestamp}-${index}`}>
                <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">{message.role}</p>
                <p className="whitespace-pre-wrap break-words">{messageText(message) || c.empty}</p>
              </article>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface PagesAppProps {
  context: MatrixPagesContext
  onNavigate: (page: 'connections' | 'providers') => Promise<void>
}

function PagesApp({ context, onNavigate }: PagesAppProps) {
  const c = pagesCopy[normalizeLocale(context.locale)]
  const curator = useMemo(() => createMatrixCuratorClient(request => bridge().api(request)), [])
  const maintenance = useMemo(() => createMatrixCommandCenterOpsClient(request => bridge().api(request)), [])
  const commandCenter = useMemo(() => createMatrixCommandCenterClient(request => bridge().api(request)), [])
  const debugShare = useMemo(() => createMatrixDebugClient(request => bridge().api(request)), [])
  const starmap = useMemo(() => createMatrixStarmapClient(request => bridge().api(request)), [])
  const cron = useMemo(cronClient, [])
  const artifacts = useMemo(artifactsClient, [])
  const skills = useMemo(skillsClient, [])
  const hub = useMemo(hubClient, [])
  const runtime = useMemo(runtimeClient, [])
  const auxiliary = useMemo(auxiliaryClient, [])
  const computerUse = useMemo(computerUseClient, [])
  const computerUseGrant = useMemo(computerUseGrantClient, [])
  const voiceSettings = useMemo(voiceSettingsClient, [])
  const providers = useMemo(() => createMatrixProviderSettingsClient(request => bridge().api(request)), [])
  const toolSettings = useMemo(toolSettingsClient, [])
  const mcp = useMemo(() => createMatrixMcpSettingsClient(request => bridge().api(request)), [])
  const [sessionId, setSessionId] = useState<null | string>(null)
  const close = () => void bridge().close()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageAppearance appearance={context.appearance} />
      <NotificationStack />
      <div className="min-h-0 flex-1">
        {context.page === 'scheduled' ? (
          <CronPresentation client={cron} deliveryValues={['local']} hideModelOverride onClose={close} />
        ) : context.page === 'starmap' ? (
          <MatrixStarmap agentName={context.agentName} client={starmap} onClose={close} />
        ) : context.page === 'command-center' ? (
          <MatrixCommandCenter
            agentName={context.agentName}
            client={commandCenter}
            curatorClient={curator}
            debugClient={debugShare}
            onClose={close}
            opsClient={maintenance}
          />
        ) : context.page === 'runtime' ? (
          <MatrixRuntimeSettings
            agentName={context.agentName}
            auxiliaryClient={auxiliary}
            client={runtime}
            computerUseClient={computerUse}
            computerUseGrantClient={computerUseGrant}
            onClose={close}
            toolSettingsClient={toolSettings}
            voiceSettingsClient={voiceSettings}
          />
        ) : context.page === 'providers' ? (
          <div className="flex h-full min-h-0 flex-col" data-matrix-connections-advanced>
            <div className="flex shrink-0 flex-col gap-3 px-6 pt-5">
              <Button className="self-start" onClick={() => void onNavigate('connections')} size="sm" variant="text">
                {connectionsCopy[normalizeLocale(context.locale)].back}
              </Button>
              <NoticeBand tone="notice">{connectionsCopy[normalizeLocale(context.locale)].advancedWarning}</NoticeBand>
            </div>
            <div className="min-h-0 flex-1">
              <MatrixProvidersSettings agentName={context.agentName} client={providers} onClose={close} />
            </div>
          </div>
        ) : context.page === 'connections' ? (
          <MatrixConnections
            agentName={context.agentName}
            client={providers}
            onClose={close}
            onOpenAdvanced={() => onNavigate('providers')}
            onOpenExternal={url => bridge().openExternal(url)}
          />
        ) : context.page === 'mcp' ? (
          <MatrixMcpSettings agentName={context.agentName} client={mcp} onClose={close} />
        ) : context.page === 'skills' ? (
          <SkillsPresentation
            appearance={context.appearance}
            client={skills}
            initialHubQuery={context.hub ? matrixHubSkillName(context.hub) : undefined}
            onClose={close}
            renderHub={(query, onInstalled) => (
              <MatrixSkillsHub client={hub} focus={context.hub} onInstalled={onInstalled} query={query} />
            )}
          />
        ) : (
          <ArtifactsPresentation
            client={artifacts}
            onOpenExternal={url => bridge().openExternal(url)}
            onOpenSession={setSessionId}
            readMedia={path => bridge().readMedia(path)}
          />
        )}
      </div>
      <SessionDialog onOpenChange={open => !open && setSessionId(null)} sessionId={sessionId} />
      <p className="shrink-0 bg-background px-3 py-1 text-right text-[0.65rem] text-muted-foreground">
        {context.agentName} · {context.jobsRunHere ? c.jobs : c.stored}
      </p>
    </div>
  )
}

function Root() {
  const { locale, t } = useI18n()
  const c = pagesCopy[locale]
  const [context, setContext] = useState<MatrixPagesContext | null>(null)
  const [error, setError] = useState<string | null>(null)

  const retry = () => {
    setError(null)
    setContext(null)
    void bridge()
      .context()
      .then(result => {
        if (isContextError(result)) {
          setError(result.error)
        } else if (!MATRIX_PAGE_IDS.includes(result.page)) {
          setError('matrix_pages_context_invalid')
        } else {
          setContext(result)
        }
      })
      .catch(reason => setError(reason instanceof Error ? reason.message : 'Could not start local management pages'))
  }

  useEffect(() => {
    retry()
  }, [])

  if (error) {
    return (
      <main className="grid h-full place-items-center bg-background p-6 text-center">
        <div className="max-w-sm space-y-3">
          <p className="text-sm text-muted-foreground">{c.failed}</p>
          <button
            className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
            onClick={retry}
            type="button"
          >
            {t.common.retry}
          </button>
        </div>
      </main>
    )
  }

  if (!context) {
    return <PageLoader label={c.loading} />
  }

  return (
    <I18nProvider configClient={null} initialLocale={context.locale}>
      <PagesApp
        context={context}
        key={context.page}
        onNavigate={async page => {
          setError(null)
          setContext(null)

          try {
            const next = await bridge().navigateConnections(page)
            setContext(next)
          } catch {
            setError('matrix_pages_unavailable')
          }
        }}
      />
    </I18nProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <I18nProvider configClient={null}>
          <Root />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  </StrictMode>
)
