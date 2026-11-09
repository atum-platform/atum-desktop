export interface AtumArtifactRef {
  kind: 'artifact'
  resourceId: string
  type: string
  title: string
  status: 'generating' | 'ready'
  presentation?: { intent: 'open' }
}

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const ALLOWED_KEYS = new Set(['kind', 'resource_id', 'type', 'title', 'status', 'presentation'])

export function parseAtumArtifactRefs(value: unknown): AtumArtifactRef[] {
  if (!Array.isArray(value) || value.length > 16) {
    return []
  }

  const refs: AtumArtifactRef[] = []
  const seen = new Set<string>()

  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return []
    }

    const row = entry as Record<string, unknown>
    const keys = Object.keys(row)

    if (keys.length < 5 || keys.length > 6 || keys.some(key => !ALLOWED_KEYS.has(key))) {
      return []
    }

    if (
      row.kind !== 'artifact' ||
      typeof row.resource_id !== 'string' ||
      !RESOURCE_ID_PATTERN.test(row.resource_id) ||
      seen.has(row.resource_id) ||
      typeof row.type !== 'string' ||
      row.type.length < 1 ||
      row.type.length > 100 ||
      typeof row.title !== 'string' ||
      row.title.length < 1 ||
      row.title.length > 500 ||
      (row.status !== 'generating' && row.status !== 'ready') ||
      (row.presentation !== undefined &&
        (!row.presentation ||
          typeof row.presentation !== 'object' ||
          Array.isArray(row.presentation) ||
          Object.keys(row.presentation).length !== 1 ||
          (row.presentation as Record<string, unknown>).intent !== 'open'))
    ) {
      return []
    }

    seen.add(row.resource_id)
    refs.push({
      kind: 'artifact',
      resourceId: row.resource_id,
      type: row.type,
      title: row.title,
      status: row.status,
      ...(row.presentation === undefined ? {} : { presentation: { intent: 'open' } })
    })
  }

  return refs
}
