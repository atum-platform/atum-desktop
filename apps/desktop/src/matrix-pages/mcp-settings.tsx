import { useCallback, useEffect, useRef, useState } from 'react'

import { PanelEmpty } from '@/app/overlays/panel'
import { ListRow, Pill, SettingsContent, SettingsSection, SettingsSkeleton } from '@/app/settings/primitives'
import { ServerIconActions, ServerSwitch } from '@/app/skills/mcp-presentation'
import { Button } from '@/components/ui/button'
import { codiconIcon } from '@/components/ui/codicon'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { X } from '@/lib/icons'

import type {
  MatrixMcpAddInput,
  MatrixMcpCatalogEntry,
  MatrixMcpResult,
  MatrixMcpSettingsClient,
  MatrixMcpSnapshot
} from '../../shared/matrix-mcp-settings'

import { mcpSettingsCopy } from './mcp-copy'

interface ActiveOperation {
  id: string
  kind: 'auth' | 'install'
  name: string
}
interface MatrixMcpSettingsProps {
  client: MatrixMcpSettingsClient
  agentName: string
  onClose?: () => void
}
type Outcome = 'applied' | 'cancelled' | 'error' | 'uncertain' | 'stopped' | 'busy' | null
const MCP_ICON = codiconIcon('plug')
const CATALOG_ICON = codiconIcon('extensions')

/** Transport-free management for exactly one native-selected owned agent. */
export function MatrixMcpSettings({ client, agentName, onClose }: MatrixMcpSettingsProps) {
  const { t, locale } = useI18n()
  const copy = mcpSettingsCopy[locale]
  const m = t.settings.mcp
  const [snapshot, setSnapshot] = useState<MatrixMcpSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [operation, setOperation] = useState<ActiveOperation | null>(null)
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [testResults, setTestResults] = useState<Record<string, Extract<MatrixMcpResult, { status: 'tested' }>>>({})
  const [addOpen, setAddOpen] = useState(false)
  const epoch = useRef(0)
  const requestPending = useRef(false)
  const readGeneration = useRef(0)
  const operationGeneration = useRef(0)

  const refresh = useCallback(
    async (scopeEpoch = epoch.current) => {
      const generation = ++readGeneration.current
      setLoading(true)

      try {
        const value = await client.snapshot()

        if (epoch.current !== scopeEpoch || generation !== readGeneration.current) {
          return false
        }

        setSnapshot(value)

        return true
      } catch {
        if (epoch.current === scopeEpoch && generation === readGeneration.current) {
          setOutcome('error')
        }

        return false
      } finally {
        if (epoch.current === scopeEpoch && generation === readGeneration.current) {
          setLoading(false)
        }
      }
    },
    [client]
  )

  useEffect(() => {
    const current = ++epoch.current
    setSnapshot(null)
    setLoading(true)
    setPending(false)
    setOperation(null)
    setOutcome(null)
    setTestResults({})
    setAddOpen(false)
    requestPending.current = false
    operationGeneration.current += 1
    void refresh(current)

    return () => {
      epoch.current += 1
      readGeneration.current += 1
      operationGeneration.current += 1
    }
  }, [refresh])

  const complete = useCallback(
    async (current: number) => {
      if (epoch.current !== current) {
        return
      }

      setTestResults({})
      const read = await refresh(current)

      if (epoch.current === current) {
        setOutcome(read ? 'applied' : 'uncertain')
      }
    },
    [refresh]
  )

  const submit = async (
    perform: () => Promise<MatrixMcpResult>,
    target?: { name: string; kind: 'auth' | 'install' }
  ): Promise<boolean> => {
    if (requestPending.current || operation) {
      return false
    }

    const current = epoch.current
    requestPending.current = true
    setPending(true)
    setOutcome(null)

    try {
      const result = await perform()

      if (epoch.current !== current) {
        return false
      }

      if (result.status === 'operation' && target) {
        if (result.state === 'applied') {
          await complete(current)
        } else if (result.state === 'failed') {
          setOutcome('error')
        } else {
          setOperation({ id: result.operationId, ...target })
        }

        return result.state !== 'failed'
      }

      if (result.status === 'tested' && target) {
        setTestResults(previous => ({ ...previous, [target.name]: result }))

        return result.ok
      }

      if (result.status === 'applied') {
        await complete(current)

        return true
      }

      setOutcome(result.status === 'cancelled' ? 'cancelled' : 'error')

      return false
    } catch (error) {
      if (epoch.current === current) {
        setOutcome(error instanceof Error && error.message === 'pages_agent_busy' ? 'busy' : 'error')
      }

      return false
    } finally {
      if (epoch.current === current) {
        requestPending.current = false
        setPending(false)
      }
    }
  }

  useEffect(() => {
    if (!operation) {
      return
    }

    const current = epoch.current
    const generation = ++operationGeneration.current
    let timer: ReturnType<typeof setTimeout> | undefined
    let retired = false

    const poll = async () => {
      try {
        const result = await (operation.kind === 'auth'
          ? client.authStatus(operation.id)
          : client.installStatus(operation.id))

        if (retired || current !== epoch.current || generation !== operationGeneration.current) {
          return
        }

        if (result.status !== 'operation' || result.operationId !== operation.id) {
          throw new Error('invalid_operation')
        }

        if (result.state === 'applied') {
          setOperation(null)
          await complete(current)

          return
        }

        if (result.state === 'failed' || result.state === 'cancelled') {
          setOperation(null)
          setOutcome(result.state === 'failed' ? 'error' : 'stopped')

          return
        }

        timer = setTimeout(() => void poll(), 1500)
      } catch {
        if (!retired && current === epoch.current && generation === operationGeneration.current) {
          setOperation(null)
          setOutcome('uncertain')
        }
      }
    }

    timer = setTimeout(() => void poll(), 1500)

    return () => {
      retired = true

      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [client, complete, operation])

  const cancelWatching = () => {
    if (!operation || operation.kind !== 'auth') {
      return
    }

    operationGeneration.current += 1
    setOperation(null)
    setOutcome('stopped')
    // The UI cancels synchronously; no false claim that an already-authorized
    // browser/SDK worker was rolled back. Native continuation is retired too.
    void client.cancelAuth(operation.id).catch(() => {})
  }

  const busy = pending || operation !== null || loading
  const actionsBlocked = busy || outcome === 'error' || outcome === 'uncertain'

  const outcomeCopy =
    outcome === 'error'
      ? copy.error
      : outcome === 'uncertain'
        ? copy.uncertain
        : outcome === 'stopped'
          ? copy.stoppedWatching
          : outcome === 'busy'
            ? copy.busy
            : outcome === 'cancelled'
              ? copy.cancelled
              : copy.applied

  return (
    <div className="h-full min-h-0" data-matrix-mcp-settings>
      <SettingsContent>
        <header className="flex items-start gap-3 py-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold">{copy.title}</h1>
            <p className="mt-1 text-xs text-muted-foreground">{copy.scope(agentName)}</p>
          </div>
          {onClose && (
            <Tip label={copy.close}>
              <Button aria-label={copy.close} onClick={onClose} size="icon-xs" variant="ghost">
                <X aria-hidden />
              </Button>
            </Tip>
          )}
        </header>
        <p className="text-xs text-muted-foreground">{copy.deferred}</p>
        <p className="text-xs text-muted-foreground">{copy.privateSettings}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() =>
              void refresh().then(ok => {
                if (ok) {
                  setOutcome(null)
                }
              })
            }
            size="sm"
            variant="secondary"
          >
            {copy.refresh}
          </Button>
          <Button
            disabled={actionsBlocked || !snapshot}
            onClick={() => void submit(() => client.reload())}
            size="sm"
            variant="secondary"
          >
            {m.reload}
          </Button>
          <Button disabled={actionsBlocked || !snapshot} onClick={() => setAddOpen(open => !open)} size="sm">
            {m.newServer}
          </Button>
        </div>
        {loading && !snapshot && <SettingsSkeleton sections={[{ heading: true, rows: 3 }]} />}
        {(pending || operation) && (
          <NoticeBand role="status" tone="notice">
            {operation?.kind === 'auth' ? m.waitingForBrowser : copy.pending}
            {operation?.kind === 'auth' && (
              <Button onClick={cancelWatching} size="inline" variant="textStrong">
                {copy.cancelWatching}
              </Button>
            )}
          </NoticeBand>
        )}
        {outcome && (
          <NoticeBand role="status" tone={outcome === 'error' || outcome === 'uncertain' ? 'failure' : 'notice'}>
            {outcomeCopy}
          </NoticeBand>
        )}
        {addOpen && (
          <McpAddForm
            disabled={actionsBlocked}
            key={agentName}
            onCancel={() => setAddOpen(false)}
            onSave={async input => {
              const applied = await submit(() => client.add(input))

              if (applied) {
                setAddOpen(false)
              }

              return applied
            }}
          />
        )}
        {snapshot && (
          <>
            <SettingsSection icon={MCP_ICON} title={m.tabServers}>
              {snapshot.servers.length === 0 && (
                <PanelEmpty description={m.emptyDesc} icon="plug" title={m.emptyTitle} />
              )}
              {snapshot.servers.map(server => (
                <ListRow
                  action={
                    <div className="flex items-center gap-2">
                      {server.transport === 'http' && ['none', 'oauth'].includes(server.auth) && (
                        <Button
                          disabled={actionsBlocked}
                          onClick={() =>
                            void submit(() => client.authenticate(server.name), { name: server.name, kind: 'auth' })
                          }
                          size="xs"
                          variant="secondary"
                        >
                          {m.authenticate}
                        </Button>
                      )}
                      <ServerIconActions
                        onProbe={() => void submit(() => client.test(server.name), { name: server.name, kind: 'auth' })}
                        onRemove={() => void submit(() => client.remove(server.name))}
                        probing={false}
                        saving={actionsBlocked}
                      />
                      <ServerSwitch
                        disabled={actionsBlocked}
                        enabled={server.enabled}
                        name={server.name}
                        onToggle={enabled => void submit(() => client.setEnabled(server.name, enabled))}
                      />
                    </div>
                  }
                  description={
                    <>
                      <span>
                        {server.transport === 'stdio'
                          ? copy.stdio
                          : server.transport === 'http'
                            ? copy.http
                            : copy.unknown}{' '}
                        ·{' '}
                        {server.auth === 'none'
                          ? copy.none
                          : server.auth === 'oauth'
                            ? copy.oauth
                            : server.auth === 'header'
                              ? copy.bearer
                              : copy.unknown}
                      </span>
                      {testResults[server.name] && (
                        <span className="block" role="status">
                          {testResults[server.name].ok
                            ? m.capabilitySummary(
                                testResults[server.name].toolCount,
                                testResults[server.name].prompts,
                                testResults[server.name].resources
                              )
                            : m.testFailed}
                        </span>
                      )}
                    </>
                  }
                  key={server.name}
                  title={server.name}
                />
              ))}
            </SettingsSection>
            <SettingsSection icon={CATALOG_ICON} title={m.tabCatalog}>
              {snapshot.catalog.length === 0 && (
                <PanelEmpty description={m.catalogEmpty} icon="plug" title={m.tabCatalog} />
              )}
              {snapshot.catalog.map(entry => (
                <McpCatalogRow
                  disabled={actionsBlocked}
                  entry={entry}
                  key={entry.name}
                  onInstall={env =>
                    submit(() => client.install(entry.name, env), { name: entry.name, kind: 'install' })
                  }
                />
              ))}
            </SettingsSection>
          </>
        )}
      </SettingsContent>
    </div>
  )
}

function McpAddForm({
  disabled,
  onSave,
  onCancel
}: {
  disabled: boolean
  onSave: (input: MatrixMcpAddInput) => Promise<boolean>
  onCancel: () => void
}) {
  const { t, locale } = useI18n()
  const copy = mcpSettingsCopy[locale]
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('[]')
  const [env, setEnv] = useState('{}')
  const [url, setUrl] = useState('')
  const [auth, setAuth] = useState<'none' | 'oauth' | 'header'>('none')
  const [token, setToken] = useState('')
  const [invalid, setInvalid] = useState(false)

  const save = async () => {
    setInvalid(false)

    try {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(name)) {
        throw new Error('invalid_name')
      }

      let input: MatrixMcpAddInput

      if (transport === 'stdio') {
        const parsedArgs: unknown = JSON.parse(args)
        const parsedEnv: unknown = JSON.parse(env)

        if (
          !command.trim() ||
          !Array.isArray(parsedArgs) ||
          parsedArgs.some(arg => typeof arg !== 'string') ||
          !parsedEnv ||
          typeof parsedEnv !== 'object' ||
          Array.isArray(parsedEnv) ||
          Object.values(parsedEnv).some(value => typeof value !== 'string')
        ) {
          throw new Error('invalid_input')
        }

        input = { name, transport, command, args: parsedArgs as string[], env: parsedEnv as Record<string, string> }
      } else {
        const parsed = new URL(url)

        if (
          !['https:', 'http:'].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.hash ||
          (auth === 'header' && !token.trim())
        ) {
          throw new Error('invalid_input')
        }

        input = { name, transport, url, auth, ...(auth === 'header' ? { bearerToken: token } : {}) }
      }

      if (await onSave(input)) {
        setEnv('{}')
        setToken('')
      }
    } catch {
      setInvalid(true)
    }
  }

  return (
    <SettingsSection icon={MCP_ICON} title={t.settings.mcp.newServer}>
      <form
        className="space-y-3"
        onSubmit={event => {
          event.preventDefault()
          void save()
        }}
      >
        <p className="text-xs text-muted-foreground">{copy.inputOnly}</p>
        <label className="block text-xs">
          {t.settings.mcp.name}
          <Input
            autoComplete="off"
            disabled={disabled}
            maxLength={100}
            onChange={event => setName(event.target.value)}
            value={name}
          />
        </label>
        <label className="block text-xs">
          {copy.transport}
          <Select
            disabled={disabled}
            onValueChange={value => setTransport(value as 'stdio' | 'http')}
            value={transport}
          >
            <SelectTrigger aria-label={copy.transport}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">{copy.stdio}</SelectItem>
              <SelectItem value="http">{copy.http}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        {transport === 'stdio' ? (
          <>
            <label className="block text-xs">
              {copy.command}
              <Input
                autoComplete="off"
                disabled={disabled}
                maxLength={2048}
                onChange={event => setCommand(event.target.value)}
                value={command}
              />
            </label>
            <label className="block text-xs">
              {copy.args}
              <Textarea
                disabled={disabled}
                maxLength={65536}
                onChange={event => setArgs(event.target.value)}
                value={args}
              />
            </label>
            <label className="block text-xs">
              {copy.env}
              <Textarea
                disabled={disabled}
                maxLength={65536}
                onChange={event => setEnv(event.target.value)}
                value={env}
              />
            </label>
          </>
        ) : (
          <>
            <label className="block text-xs">
              {copy.url}
              <Input
                autoComplete="off"
                disabled={disabled}
                maxLength={4096}
                onChange={event => setUrl(event.target.value)}
                value={url}
              />
            </label>
            <label className="block text-xs">
              {copy.auth}
              <Select
                disabled={disabled}
                onValueChange={value => {
                  setAuth(value as 'none' | 'oauth' | 'header')
                  setToken('')
                }}
                value={auth}
              >
                <SelectTrigger aria-label={copy.auth}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{copy.none}</SelectItem>
                  <SelectItem value="oauth">{copy.oauth}</SelectItem>
                  <SelectItem value="header">{copy.bearer}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {auth === 'header' && (
              <label className="block text-xs">
                {copy.token}
                <Input
                  autoComplete="off"
                  disabled={disabled}
                  maxLength={8192}
                  onChange={event => setToken(event.target.value)}
                  type="password"
                  value={token}
                />
              </label>
            )}
          </>
        )}
        {invalid && (
          <NoticeBand role="alert" tone="failure">
            {copy.invalid}
          </NoticeBand>
        )}
        <div className="flex gap-2">
          <Button disabled={disabled} size="sm" type="submit">
            {t.settings.mcp.saveServer}
          </Button>
          <Button onClick={onCancel} size="sm" type="button" variant="text">
            {t.common.cancel}
          </Button>
        </div>
      </form>
    </SettingsSection>
  )
}

function McpCatalogRow({
  entry,
  disabled,
  onInstall
}: {
  entry: MatrixMcpCatalogEntry
  disabled: boolean
  onInstall: (env: Record<string, string>) => Promise<boolean>
}) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const [env, setEnv] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false)

  const install = async () => {
    if (entry.requiredEnv.length && !open) {
      setOpen(true)

      return
    }

    if (await onInstall(env)) {
      setEnv({})
      setOpen(false)
    }
  }

  return (
    <div>
      <ListRow
        action={
          entry.installed ? (
            <Pill>{entry.enabled ? m.catalogEnabled : m.catalogInstalled}</Pill>
          ) : (
            <Button
              disabled={disabled || (open && entry.requiredEnv.some(each => each.required && !env[each.name]?.trim()))}
              onClick={() => void install()}
              size="xs"
              variant="secondary"
            >
              {m.catalogInstall}
            </Button>
          )
        }
        description={entry.description}
        title={entry.name}
      />
      {open && (
        <div className="space-y-2 pb-3">
          {entry.requiredEnv.map(variable => (
            <label className="block text-xs" key={variable.name}>
              {variable.prompt}
              <Input
                autoComplete="off"
                disabled={disabled}
                maxLength={8192}
                onChange={event => setEnv(previous => ({ ...previous, [variable.name]: event.target.value }))}
                required={variable.required}
                type="password"
                value={env[variable.name] ?? ''}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
