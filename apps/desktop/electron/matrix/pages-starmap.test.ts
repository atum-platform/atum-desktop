import { expect, it, vi } from 'vitest'

import { MatrixPagesStarmapScope } from './pages-starmap'

function graph() {
  return {
    nodes: [
      {
        id: 'writing / notes',
        label: 'Notes',
        kind: 'skill',
        timestamp: null as number | null,
        category: 'work',
        useCount: 2,
        state: 'held',
        createdBy: 'agent',
        pinned: true
      },
      {
        id: 'memory:memory:0',
        label: '🧠'.repeat(80) + '…',
        kind: 'memory',
        memorySource: 'memory',
        timestamp: 1700000000,
        category: 'memory',
        useCount: 0,
        state: 'active',
        createdBy: 'memory',
        pinned: false
      },
      {
        id: 'memory:profile:1',
        label: 'Profile',
        kind: 'memory',
        memorySource: 'profile',
        timestamp: 1700000001,
        category: 'memory',
        useCount: 0,
        state: 'active',
        createdBy: 'memory',
        pinned: false
      }
    ],
    edges: [
      { source: 'memory:memory:0', target: 'writing / notes' },
      { source: 'writing / notes', target: 'memory:profile:1' }
    ],
    clusters: [
      { category: 'work', count: 1 },
      { category: 'memory', count: 2 }
    ],
    memory: [
      { source: 'memory', timestamp: 1700000000, title: '🧠'.repeat(80) + '…', body: '🧠'.repeat(1200) },
      { source: 'profile', timestamp: 1700000001, title: 'Profile', body: 'Owner local prose' }
    ],
    stats: {
      nodes: 1,
      learned_skills: 1,
      memory_nodes: 2,
      edges_per_node: 0,
      top_categories: [['private', 1]],
      private: 'private',
      api_key: 'private'
    }
  }
}

it('pins the existing graph read, retains topology/prose/global memory indices and drops unknown metadata', async () => {
  const raw = { ...graph(), hermes_home: '/private/home' }
  const forward = vi.fn(async () => raw)
  const scope = new MatrixPagesStarmapScope({ isCurrent: () => true, forward })
  const projected = await scope.request({ path: '/api/starmap/graph' })
  expect(forward).toHaveBeenCalledExactlyOnceWith({ path: '/api/learning/graph?profile=default', method: 'GET' })
  expect(projected.nodes).toEqual(raw.nodes)
  expect(projected.memory).toEqual(raw.memory)
  expect(projected.edges).toEqual(raw.edges)
  expect(projected.stats).toEqual({ nodes: 1, learned_skills: 1, memory_nodes: 2, edges_per_node: 0 })
  expect(JSON.stringify(projected)).not.toMatch(/api_key|hermes_home|private/)
})
it.each([
  { path: '/api/starmap/graph?profile=other' },
  { path: '/api/starmap/graph?' },
  { path: '/api/starmap/graph', method: 'POST' },
  { path: '/api/starmap/graph', body: {} },
  { path: '/api/starmap/graph', headers: {} },
  { path: '/api/starmap/node?id=writing' },
  { path: 'https://private/api/starmap/graph' },
  { path: '/api/starmap/%67raph' },
  { path: '/api/starmap/graph#private' }
])('rejects renderer authority without forwarding %j', async request => {
  const forward = vi.fn()
  const scope = new MatrixPagesStarmapScope({ isCurrent: () => true, forward })
  await expect(scope.request(request)).rejects.toThrow('matrix_pages_request_denied')
  expect(forward).not.toHaveBeenCalled()
})
it('retires before reads and after asynchronous reads', async () => {
  let current = false

  const forward = vi.fn(async () => {
    current = false

    return graph()
  })

  const scope = new MatrixPagesStarmapScope({ isCurrent: () => current, forward })
  await expect(scope.request({ path: '/api/starmap/graph' })).rejects.toThrow('agent_unavailable')
  expect(forward).not.toHaveBeenCalled()
  current = true
  await expect(scope.request({ path: '/api/starmap/graph' })).rejects.toThrow('agent_unavailable')
})
it.each([
  'dangling',
  'duplicate',
  'missing-card',
  'bad-source',
  'body-overflow',
  'nodes-overflow',
  'edges-overflow',
  'bad-time',
  'bad-count'
])('rejects malformed or oversized graphs losslessly: %s', async problem => {
  const raw = graph()

  if (problem === 'dangling') {
    raw.edges[0]!.source = 'absent'
  }

  if (problem === 'duplicate') {
    raw.nodes.push(raw.nodes[0]!)
  }

  if (problem === 'missing-card') {
    raw.memory.pop()
  }

  if (problem === 'bad-source') {
    raw.nodes[2]!.memorySource = 'memory'
  }

  if (problem === 'body-overflow') {
    raw.memory[0]!.body += '🧠'
  }

  if (problem === 'nodes-overflow') {
    raw.nodes = Array(2001).fill(raw.nodes[0])
  }

  if (problem === 'edges-overflow') {
    raw.edges = Array(10001).fill(raw.edges[0])
  }

  if (problem === 'bad-time') {
    raw.nodes[0]!.timestamp = Infinity
  }

  if (problem === 'bad-count') {
    raw.nodes[0]!.useCount = -1
  }

  const scope = new MatrixPagesStarmapScope({ isCurrent: () => true, forward: async () => raw })
  await expect(scope.request({ path: '/api/starmap/graph' })).rejects.toThrow('invalid_response')
})
it('accepts a genuine empty graph and hides transport failure details', async () => {
  const scope = new MatrixPagesStarmapScope({
    isCurrent: () => true,
    forward: async () => ({ nodes: [], edges: [], clusters: [], memory: [], stats: {} })
  })

  expect(await scope.request({ path: '/api/starmap/graph' })).toEqual({
    nodes: [],
    edges: [],
    clusters: [],
    memory: [],
    stats: {}
  })

  const broken = new MatrixPagesStarmapScope({
    isCurrent: () => true,
    forward: async () => {
      throw new Error('api_key=private')
    }
  })

  await expect(broken.request({ path: '/api/starmap/graph' })).rejects.toThrow(/^matrix_pages_starmap_failed$/)
})
