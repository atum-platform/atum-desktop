import { captureFeedback, createTransport, makeSession, Scope, updateSession } from '@sentry/core'
import { LightNodeClient } from '@sentry/node-core/light'
import { PostHog } from 'posthog-node'

import type { ReportingSink } from './atum-observability'
import type { AtumObservabilityConfig } from './desktop-services-config'
import { ReportingSessionJournal, type SafeDiagnostic } from './reporting-session-journal'

/** Explicit, memory-only SDK clients. No native dumps, SDK IPC, console/network
 * breadcrumbs, screenshots, attachments, tracing, or replay integrations. */
export function createReportingSink(options: {
  config: AtumObservabilityConfig; id: string; version: string; revision: string
  enabled: () => boolean; fetch?: typeof fetch; sessionPath?: string
  composition?: 'legacy' | 'matrix'
}): ReportingSink {
  const fetchImpl = options.fetch ?? fetch
  const release = `${options.composition === 'matrix' ? 'atum-matrix-desktop' : 'atum-desktop'}@${options.version}+${options.revision}`
  const requests = new Set<AbortController>()
  let generation = 0
  let posthog: PostHog | null = null
  let feedbackPending = false

  async function send(url: string, init: RequestInit, automatic: boolean, expectedGeneration: number) {
    if (automatic && (!options.enabled() || generation !== expectedGeneration)) {throw new Error('reporting_disabled')}
    const controller = new AbortController()

    if (automatic) {requests.add(controller)}
    const timer = setTimeout(() => controller.abort(), 5000)

    try {
      return await fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal })
    } finally {
      clearTimeout(timer)
      requests.delete(controller)
    }
  }

  function sentryClient(automatic: boolean, delivered: () => void = () => {}) {
    const expectedGeneration = generation

    // Explicit core client: our owned-window bridge is the sole renderer entry.
    // No global SDK IPC, native crash collector, or automatic instrumentation.
    const client = new LightNodeClient({
      dsn: options.config.sentryDsn, release, environment: options.config.environment,
      integrations: [], stackParser: () => [], sendDefaultPii: false,
      sendClientReports: false, includeServerName: false,
      transport: config => createTransport({ ...config, bufferSize: 30 }, async request => {
        const response = await send(config.url, {
          method: 'POST', body: request.body as BodyInit,
          headers: { 'content-type': 'application/x-sentry-envelope' }
        }, automatic, expectedGeneration)

        if (response.ok) {delivered()}

        return { statusCode: response.status }
      })
    })

    client.init()
    const scope = new Scope()
    scope.setClient(client)
    scope.setUser({ id: options.id })
    scope.setTags({ app_version: options.version, build_revision: options.revision, os: process.platform, arch: process.arch })

    return { client, scope }
  }

  let errors = sentryClient(true)
  const journal = options.sessionPath ? new ReportingSessionJournal(options.sessionPath, options.id, options.config.environment) : null

  if (!options.enabled()) {journal?.clear()}
  const previous = options.enabled() ? journal?.take() : null

  if (previous) {
    errors.client.captureSession(previous.session)

    if (previous.crash) {
      errors.scope.captureEvent({
        release: previous.session.release, timestamp: previous.session.timestamp, level: 'error',
        tags: { operation: previous.crash.operation, recovered_after_restart: 'true',
          ...(previous.crash.exitCode === undefined ? {} : { exit_code: String(previous.crash.exitCode) }),
          app_version: previous.session.release!.split('@')[1].split('+')[0],
          build_revision: previous.session.release!.split('+')[1] },
        exception: { values: [{ type: previous.crash.kind, value: `${previous.crash.operation}: ${previous.crash.kind}`, stacktrace: { frames: previous.crash.frames } }] }
      })
    }
  }

  let lastError: SafeDiagnostic | undefined
  let session: ReturnType<typeof makeSession> | null = null

  function ensureSession() {
    if (!session && options.enabled()) {
      session = makeSession({ release, environment: options.config.environment, user: { id: options.id } })
      journal?.write(session)
      errors.client.captureSession(session)
    }
  }

  ensureSession()

  function analytics(): PostHog {
    if (!posthog) {
      const expectedGeneration = generation
      posthog = new PostHog(options.config.posthogKey, {
        host: options.config.posthogHost, persistence: 'memory', disableGeoip: true,
        flushAt: 20, flushInterval: 10_000, maxQueueSize: 100,
        fetchRetryCount: 0, requestTimeout: 5000, enableExceptionAutocapture: false,
        fetch: (url, init) => send(url, init as RequestInit, true, expectedGeneration)
      })
    }

    return posthog
  }

  return {
    event(name, properties) {
      if (!options.enabled()) {return}
      ensureSession()
      analytics().capture({ distinctId: options.id, event: name, properties: { ...properties, $geoip_disable: true, $ip: null } })
    },
    error(error) {
      if (!options.enabled()) {return}
      ensureSession()
      lastError = error

      if (session) {updateSession(session, { errors: session.errors + 1 }); errors.client.captureSession(session)}
      errors.scope.captureEvent({
        level: 'error',
        exception: { values: [{ type: error.kind, value: `${error.operation}: ${error.kind}`, stacktrace: { frames: error.frames } }] },
        tags: {
          operation: error.operation,
          ...(error.exitCode === undefined ? {} : { exit_code: String(error.exitCode) }),
          ...(error.childType === undefined ? {} : { child_type: error.childType })
        }
      })
    },
    async feedback(message) {
      if (feedbackPending) {return false}
      feedbackPending = true
      let delivered = false
      const feedback = sentryClient(false, () => {delivered = true})

      try {
        captureFeedback({ message, source: 'atum-desktop' }, {}, feedback.scope)
        await feedback.client.flush(5500)

        return delivered
      } finally {
        feedbackPending = false
        void feedback.client.close(0)
      }
    },
    endSession(crashed, delivery) {
      if (!options.enabled() || !session) {return}
      updateSession(session, { status: crashed ? 'crashed' : 'exited' })
      errors.client.captureSession(session)

      // The live process-gone path already delivered this crash to Sentry. Clear
      // its marker so the next launch does not send recovered_after_restart too.
      // A dying process keeps the marker: only the journal can finish that send.
      if (delivery?.delivered) {journal?.clear()}
      else {journal?.write(session, crashed ? lastError : undefined)}

      session = null
    },
    discard() {
      generation += 1
      journal?.clear()
      session = null
      lastError = undefined

      for (const request of requests) {request.abort()}
      requests.clear()

      if (posthog) {
        void posthog.optOut()
        // Public persistence setter on pinned posthog-node 5.51.6. Clear its
        // memory queue directly: shutdown() would attempt to flush it.
        posthog.setPersistedProperty('queue' as Parameters<PostHog['setPersistedProperty']>[0], [])
        posthog = null
      }

      // Previous transport generation is permanently revoked, including work
      // already queued asynchronously by Sentry. A later opt-in gets a fresh client.
      void errors.client.close(0)
      errors = sentryClient(true)
    }
  }
}
