import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { MatrixEnrollment } from '../../shared/matrix'
import type { MatrixPagesRequest } from '../../shared/matrix-pages'

/** Roster IDs are agent principals; enrollment.principal belongs to the owner
 * and is shared by all of their agents. Keep that owner for home derivation. */
export function selectMatrixPagesAgent<T>(
  agents: readonly T[],
  enrollmentOf: (agent: T) => MatrixEnrollment,
  requested?: string
) {
  const matches = agents
    .map(agent => ({ agent, enrollment: enrollmentOf(agent) }))
    .filter(({ agent, enrollment }) =>
      requested === undefined ? agent === agents[0] : enrollment.identity?.agentPrincipal === requested
    )

  const selected = matches.length === 1 ? matches[0] : undefined

  if (!selected || selected.enrollment.state !== 'ready' || !selected.enrollment.identity) {
    throw new Error('pages_agent_unavailable')
  }

  return { agent: selected.agent, identity: selected.enrollment.identity }
}

export interface MatrixPagesForwardRequest {
  path: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
}

function denied(): never {
  throw new Error('pages_request_forbidden')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const fields = new Set([
  'prompt',
  'schedule',
  'name',
  'deliver',
  'script',
  'no_agent',
  'skills',
  'context_from',
  'enabled_toolsets',
  'workdir'
])

// Toolset keys are a single path segment. Built-in keys include underscores
// (for example image_gen and code_execution); hyphenated plugin keys remain
// valid too. Do not admit a URL/path fragment before it reaches Hermes.
const toolsetRoute = /^\/api\/tools\/toolsets\/[a-z0-9][a-z0-9_-]{0,127}$/

const learnedSkillName = /^[a-z0-9][a-z0-9._-]{0,63}$/

function isLearnedSkillName(value: unknown): value is string {
  return typeof value === 'string' && learnedSkillName.test(value) && !value.includes('..')
}

function learnedSkillBody(value: unknown, edit: boolean): Record<string, unknown> {
  if (!record(value)) {
    return denied()
  }
  const keys = Object.keys(value)
  const expected = edit ? ['id', 'content'] : ['id']

  if (keys.length !== expected.length || keys.some(key => !expected.includes(key)) || !isLearnedSkillName(value.id)) {
    return denied()
  }

  // The upstream writer still validates frontmatter and scans the skill. This
  // bounds IPC input; it is not a second skill-content validator.
  if (edit && (typeof value.content !== 'string' || value.content.length > 100_000)) {
    return denied()
  }

  return value
}

function skillToggleName(value: unknown): value is string {
  // Hermes stores this value in skills.disabled and later uses it only as an
  // exact, trimmed set membership check against SKILL.md frontmatter names.
  // Preserve hand-authored and multilingual installed names while bounding the
  // config value and excluding control characters.
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    [...value].length > 0 &&
    [...value].length <= 64 &&
    !/[\p{Cc}]/u.test(value)
  )
}

function exactToggleBody(value: unknown, name: 'skill' | 'toolset'): Record<string, unknown> {
  if (!record(value)) {
    return denied()
  }

  const keys = Object.keys(value)
  const expected = name === 'skill' ? ['name', 'enabled'] : ['enabled']

  if (
    keys.length !== expected.length ||
    keys.some(key => !expected.includes(key)) ||
    typeof value.enabled !== 'boolean'
  ) {
    return denied()
  }

  if (name === 'skill' && !skillToggleName(value.name)) {
    return denied()
  }

  return value
}

function cronBody(value: unknown, update: boolean): Record<string, unknown> {
  if (!record(value)) {
    return denied()
  }

  if (update && (Object.keys(value).length !== 1 || !record(value.updates))) {
    return denied()
  }

  const body = update ? (value.updates as Record<string, unknown>) : value

  if (Object.keys(body).some(key => !fields.has(key))) {
    return denied()
  }

  if (!update && (typeof body.schedule !== 'string' || !body.schedule.trim())) {
    return denied()
  }

  for (const [key, entry] of Object.entries(body)) {
    if (key === 'no_agent') {
      if (typeof entry !== 'boolean') {
        return denied()
      }
    } else if (['skills', 'context_from', 'enabled_toolsets'].includes(key)) {
      if (
        entry !== null &&
        (!Array.isArray(entry) ||
          entry.length > 100 ||
          entry.some(item => typeof item !== 'string' || item.length > 200))
      ) {
        return denied()
      }
    } else if (entry !== null && (typeof entry !== 'string' || entry.length > 32_768)) {
      return denied()
    }
  }

  // This surface uses the agent's established local/Matrix delivery path. Other
  // gateway destinations and provider routing remain outside this first slice.
  if (body.deliver !== undefined && body.deliver !== 'local' && body.deliver !== 'matrix') {
    return denied()
  }

  if (JSON.stringify(body).length > 128 * 1024) {
    return denied()
  }

  return update ? { updates: body } : body
}

/** Pure exact allowlist. The default profile is a native transport placeholder;
 * transport replaces it with the exact launched-home catalog profile. No
 * caller-supplied backend, profile name, headers or arbitrary query forwarding. */
export function matrixPagesRequest(value: unknown): MatrixPagesForwardRequest {
  if (!record(value) || Object.keys(value).some(key => !['path', 'method', 'body'].includes(key))) {
    return denied()
  }

  if (
    typeof value.path !== 'string' ||
    value.path.length > 2048 ||
    /[%\\#]/.test(value.path) ||
    [...value.path].some(character => character.charCodeAt(0) <= 32) ||
    value.path.includes('..')
  ) {
    return denied()
  }

  const method = value.method ?? 'GET'

  if (typeof method !== 'string' || !['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    return denied()
  }

  const url = new URL(value.path, 'http://pages.invalid')

  if (url.origin !== 'http://pages.invalid' || !value.path.startsWith('/api/')) {
    return denied()
  }

  const route = url.pathname
  const query = url.searchParams
  const allowedQuery = new Set<string>()
  const output = new URLSearchParams()
  let body: unknown

  if (route === '/api/learning/node' && ['GET', 'PUT', 'DELETE'].includes(method)) {
    if (method === 'GET') {
      allowedQuery.add('id')
      const id = query.get('id')

      if (!isLearnedSkillName(id)) {
        return denied()
      }
      output.set('id', id)
    } else {
      body = learnedSkillBody(value.body, method === 'PUT')
    }

    // The optional upstream restriction rejects memory, external, bundled and
    // Hub targets. Neither this flag nor the selected profile is caller-owned.
    output.set('local_skill_only', 'true')
  } else if (route === '/api/skills' && method === 'GET') {
    // List installed skill metadata only.
  } else if (route === '/api/skills/toggle' && method === 'PUT') {
    body = exactToggleBody(value.body, 'skill')
  } else if (route === '/api/tools/toolsets' && method === 'GET') {
    // List installed toolset metadata only.
  } else if (toolsetRoute.test(route) && method === 'PUT') {
    body = exactToggleBody(value.body, 'toolset')
  } else if (route === '/api/cron/jobs' && (method === 'GET' || method === 'POST')) {
    if (method === 'POST') {
      body = cronBody(value.body, false)
    }
  } else if (/^\/api\/cron\/jobs\/[A-Za-z0-9_-]{1,200}$/.test(route) && (method === 'PUT' || method === 'DELETE')) {
    if (method === 'PUT') {
      body = cronBody(value.body, true)
    }
  } else if (/^\/api\/cron\/jobs\/[A-Za-z0-9_-]{1,200}\/(pause|resume|trigger)$/.test(route) && method === 'POST') {
    // No body and no profile routing.
  } else if (/^\/api\/cron\/jobs\/[A-Za-z0-9_-]{1,200}\/runs$/.test(route) && method === 'GET') {
    allowedQuery.add('limit')
    const raw = query.get('limit') ?? '20'

    if (!/^\d+$/.test(raw)) {
      return denied()
    }

    output.set('limit', String(Math.max(1, Math.min(20, Number(raw)))))
  } else if (route === '/api/profiles/sessions' && method === 'GET') {
    for (const [key, fallback, maximum] of [
      ['limit', 30, 100],
      ['offset', 0, 10_000],
      ['min_messages', 1, 100]
    ] as const) {
      allowedQuery.add(key)
      const raw = query.get(key) ?? String(fallback)

      if (!/^\d+$/.test(raw)) {
        return denied()
      }

      output.set(key, String(Math.min(maximum, Number(raw))))
    }

    for (const [key, choices, fallback] of [
      ['archived', ['exclude', 'include', 'only'], 'exclude'],
      ['order', ['created', 'recent'], 'recent']
    ] as const) {
      allowedQuery.add(key)
      const raw = query.get(key) ?? fallback

      if (!(choices as readonly string[]).includes(raw)) {
        return denied()
      }

      output.set(key, raw)
    }
  } else if (/^\/api\/sessions\/[A-Za-z0-9_-]{1,200}(\/messages)?$/.test(route) && method === 'GET') {
    // Detail and message reads stay in this backend's one selected home.
  } else {
    return denied()
  }

  if (body === undefined && value.body !== undefined) {
    return denied()
  }

  if ((url.search || value.path.endsWith('?')) && allowedQuery.size === 0) {
    return denied()
  }

  for (const key of query.keys()) {
    if (!allowedQuery.has(key) || query.getAll(key).length !== 1) {
      return denied()
    }
  }

  output.set('profile', 'default')

  return {
    path: `${route}?${output}`,
    method: method as MatrixPagesForwardRequest['method'],
    ...(body === undefined ? {} : { body })
  }
}

export async function forwardMatrixPagesRequest(
  value: MatrixPagesRequest,
  request: (input: MatrixPagesForwardRequest) => Promise<unknown>
) {
  return request(matrixPagesRequest(value))
}

/** Image bytes only, under this agent's real home. Never expose a filesystem or
 * token-bearing media URL, and do not treat a misleading extension as a MIME type. */
export async function readMatrixPagesMedia(home: string, value: string): Promise<string> {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) {
    return denied()
  }

  const root = await realpath(home)
  let candidate = value

  if (value.startsWith('file:')) {
    try {
      candidate = fileURLToPath(value)
    } catch {
      return denied()
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('~')) {
    return denied()
  }

  const file = await realpath(path.resolve(root, candidate))
  const relative = path.relative(root, file)

  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    return denied()
  }

  const handle = await open(file, 'r')

  try {
    const stat = await handle.stat()

    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) {
      return denied()
    }

    const data = await handle.readFile()

    if (data.length > 8 * 1024 * 1024) {
      return denied()
    }

    const mime = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : data[0] === 255 && data[1] === 216 && data[2] === 255
        ? 'image/jpeg'
        : ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))
          ? 'image/gif'
          : data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP'
            ? 'image/webp'
            : undefined

    if (!mime) {
      return denied()
    }

    return `data:${mime};base64,${data.toString('base64')}`
  } finally {
    await handle.close()
  }
}
