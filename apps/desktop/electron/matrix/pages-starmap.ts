import type { MatrixStarmapGraph, MatrixStarmapNode } from '../../shared/matrix-starmap'

import type { MatrixPagesForwardRequest } from './pages-bridge'

interface Options {
  isCurrent(): boolean
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
}
const PATH = '/api/starmap/graph'

const STATISTICS = [
  'nodes',
  'related_edges',
  'edges_per_node',
  'linked_nodes',
  'isolated_pct',
  'categories',
  'agent_created',
  'used',
  'memory_nodes',
  'memory_skill_edges',
  'learned_skills'
] as const

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(): never {
  throw new Error('matrix_pages_starmap_invalid_response')
}

function text(value: unknown, max: number, empty = false): string {
  // Python slices memory by Unicode code points, not UTF-16 code units.
  if (typeof value !== 'string' || value.length > max * 2 || [...value].length > max || (!empty && !value)) {
    return invalid()
  }

  return value
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return invalid()
  }

  return value
}

function timestamp(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > 8.64e12) {
    return invalid()
  }

  return value
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    return invalid()
  }

  return value
}

function source(value: unknown): 'memory' | 'profile' {
  if (value !== 'memory' && value !== 'profile') {
    return invalid()
  }

  return value
}

function project(value: unknown): MatrixStarmapGraph {
  if (!record(value) || Object.hasOwn(value, 'error') || !record(value.stats)) {
    return invalid()
  }

  const memory = array(value.memory, 1000).map(card => {
    if (!record(card)) {
      return invalid()
    }

    return {
      source: source(card.source),
      timestamp: timestamp(card.timestamp),
      title: text(card.title, 81, true),
      body: text(card.body, 1200, true)
    }
  })

  const nodes: MatrixStarmapNode[] = array(value.nodes, 2000).map(node => {
    if (!record(node) || (node.kind !== 'skill' && node.kind !== 'memory') || typeof node.pinned !== 'boolean') {
      return invalid()
    }

    const id = text(node.id, 512)

    if ([...id].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      return invalid()
    }

    return {
      id,
      label: text(node.label, 512, true),
      kind: node.kind,
      ...(node.kind === 'memory' ? { memorySource: source(node.memorySource) } : {}),
      timestamp: timestamp(node.timestamp),
      category: text(node.category, 256, true),
      useCount: count(node.useCount),
      state: text(node.state, 64),
      createdBy: node.createdBy === null ? null : text(node.createdBy, 128),
      pinned: node.pinned
    }
  })

  const byId = new Map(nodes.map(node => [node.id, node]))

  if (byId.size !== nodes.length || nodes.filter(node => node.kind === 'memory').length !== memory.length) {
    return invalid()
  }

  memory.forEach((card, index) => {
    const node = byId.get(`memory:${card.source}:${index}`)

    if (!node || node.kind !== 'memory' || node.memorySource !== card.source) {
      return invalid()
    }
  })

  const edges = array(value.edges, 10000).map(edge => {
    if (!record(edge)) {
      return invalid()
    }

    const a = text(edge.source, 512)
    const b = text(edge.target, 512)

    if (!byId.has(a) || !byId.has(b)) {
      return invalid()
    }

    return { source: a, target: b }
  })

  const clusters = array(value.clusters, 2000).map(cluster => {
    if (!record(cluster)) {
      return invalid()
    }

    return { category: text(cluster.category, 256, true), count: count(cluster.count) }
  })

  const stats: Record<string, number> = {}

  for (const key of STATISTICS) {
    const number = value.stats[key]

    if (typeof number === 'number' && Number.isFinite(number) && number >= 0) {
      stats[key] = number
    }
  }

  return { nodes, edges, clusters, memory, stats }
}

export function isMatrixStarmapRequest(value: unknown): boolean {
  return record(value) && typeof value.path === 'string' && value.path.startsWith('/api/starmap/')
}

export class MatrixPagesStarmapScope {
  constructor(private readonly options: Options) {}
  async request(value: unknown): Promise<MatrixStarmapGraph> {
    if (
      !record(value) ||
      value.path !== PATH ||
      (value.method !== undefined && value.method !== 'GET') ||
      Object.keys(value).some(key => !['path', 'method'].includes(key))
    ) {
      throw new Error('matrix_pages_request_denied')
    }

    if (!this.options.isCurrent()) {
      throw new Error('matrix_pages_agent_unavailable')
    }

    try {
      const result = await this.options.forward({ path: '/api/learning/graph?profile=default', method: 'GET' })

      if (!this.options.isCurrent()) {
        throw new Error('matrix_pages_agent_unavailable')
      }

      return project(result)
    } catch (error) {
      if (
        error instanceof Error &&
        ['matrix_pages_agent_unavailable', 'matrix_pages_starmap_invalid_response'].includes(error.message)
      ) {
        throw error
      }

      throw new Error('matrix_pages_starmap_failed')
    }
  }
}
