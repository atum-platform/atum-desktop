import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { decodeShareCode, encodeShareCode } from '@/app/starmap/share-code'
import type { StarMapCanvasProps } from '@/app/starmap/star-map-canvas'
import { I18nProvider } from '@/i18n'

import type { MatrixStarmapClient, MatrixStarmapGraph } from '../../shared/matrix-starmap'
import { matrixStarmapCopy } from '../../shared/matrix-starmap-copy'

import { MatrixStarmap } from './starmap'
import { createMatrixStarmapClient } from './starmap-client'

vi.mock('@/app/starmap/star-map-canvas', () => ({
  StarMapCanvas: (props: StarMapCanvasProps) => (
    <div>
      <output>{props.graph.nodes.map(node => node.label).join(',')}</output>
      {props.NodeMenu && <span>Node authority</span>}
      <button
        onClick={() => {
          const imported = {
            ...props.graph,
            nodes: props.graph.nodes.map(node => ({ ...node, label: 'Imported fixture' }))
          }

          props.onImport?.(decodeShareCode(encodeShareCode(imported)))
        }}
      >
        Import fixture
      </button>
      <button onClick={props.onResetMap}>Reset fixture</button>
    </div>
  )
}))

function graph(label = 'Selected skill'): MatrixStarmapGraph {
  return {
    nodes: [
      {
        id: 'skill-a',
        label,
        kind: 'skill',
        timestamp: 1700000000,
        category: 'work',
        useCount: 1,
        state: 'active',
        createdBy: 'agent',
        pinned: false
      }
    ],
    edges: [],
    clusters: [{ category: 'work', count: 1 }],
    memory: [],
    stats: {}
  }
}

function draw(client: MatrixStarmapClient, name = 'Ada', locale: keyof typeof matrixStarmapCopy = 'en') {
  return (
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixStarmap agentName={name} client={client} />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it('loads on open, imports/resets locally and refreshes explicitly without node authority', async () => {
  const client = { graph: vi.fn(async () => graph()) }
  render(draw(client))
  await screen.findByText('Selected skill')
  expect(client.graph).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Import fixture' }))
  await screen.findByText('Imported fixture')
  expect(screen.getByText('imported map')).toBeTruthy()
  expect(client.graph).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Reset fixture' }))
  await screen.findByText('Selected skill')
  expect(screen.queryByText('imported map')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Import fixture' }))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByText('Selected skill')
  expect(screen.queryByText('imported map')).toBeNull()
  expect(client.graph).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('Node authority')).toBeNull()
})
it('keeps failures generic, recovers and leaves import available for an empty home', async () => {
  const client = { graph: vi.fn(async () => ({ nodes: [], edges: [], clusters: [], memory: [], stats: {} })) }
  client.graph.mockRejectedValueOnce(new Error('api_key=private'))
  render(draw(client))
  await screen.findByRole('alert')
  expect(globalThis.document.body.textContent).not.toMatch(/api_key|private/)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByText('Nothing learned yet')
  expect(screen.getByRole('button', { name: 'Import fixture' })).toBeTruthy()
})
it('retires late responses when the selected agent/client changes', async () => {
  let resolve!: (value: MatrixStarmapGraph) => void

  const first = {
    graph: vi.fn(
      () =>
        new Promise<MatrixStarmapGraph>(done => {
          resolve = done
        })
    )
  }

  const view = render(draw(first))
  const next = { graph: vi.fn(async () => graph('Next agent')) }
  view.rerender(draw(next, 'Babbage'))
  await screen.findByText('Next agent')
  await act(async () => {
    resolve(graph('Old agent'))
  })
  expect(screen.queryByText('Old agent')).toBeNull()
  expect(globalThis.document.body.textContent).toContain('Babbage')
})
it('retires a late refresh result after unmount', async () => {
  let resolve!: (value: MatrixStarmapGraph) => void
  const client = { graph: vi.fn(async () => graph()) }
  const view = render(draw(client))
  await screen.findByText('Selected skill')
  client.graph.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(client.graph).toHaveBeenCalledTimes(2))
  view.unmount()
  await act(async () => {
    resolve(graph('Unmounted agent'))
  })
  expect(screen.queryByText('Unmounted agent')).toBeNull()
})
it('client sends only the synthetic graph read', async () => {
  const request = vi.fn(async () => graph() as never)
  await createMatrixStarmapClient(request).graph()
  expect(request).toHaveBeenCalledExactlyOnceWith({ path: '/api/starmap/graph' })
})
it.each(Object.keys(matrixStarmapCopy) as (keyof typeof matrixStarmapCopy)[])(
  'localizes selected-agent context in %s',
  async locale => {
    render(draw({ graph: async () => graph() }, 'Ada', locale))
    await screen.findByText('Selected skill')
    expect(screen.getByRole('heading', { name: matrixStarmapCopy[locale].title })).toBeTruthy()
    expect(globalThis.document.body.textContent).toContain(matrixStarmapCopy[locale].help)
  }
)
