import { describe, expect, it } from 'vitest'

import { matrixPagesOpenLogLine, matrixPagesOpenOutcome } from './pages-open-log'

describe('management page open log', () => {
  it.each([
    [{ viewId: 'matrix-pages-1' }, 'opened'],
    [{ error: 'pages_agent_cloud' }, 'cloud_agent'],
    [{ error: 'pages_agent_not_running' }, 'agent_not_running'],
    [{ error: 'pages_agent_unavailable' }, 'agent_unavailable'],
    [{ error: 'matrix_pages_load_failed' }, 'load_failed'],
    [{ error: 'pages_invalid_request' }, 'invalid'],
    [{ error: 'some new failure with /home/example/path' }, 'failed'],
    [null, 'failed']
  ])('maps %j to a closed outcome', (result, outcome) => {
    expect(matrixPagesOpenOutcome(result)).toBe(outcome)
  })

  it('names the page and a short agent id only', () => {
    expect(
      matrixPagesOpenLogLine({
        page: 'connections',
        agentPrincipal: '00000000-0000-4000-8000-bd8dca333678',
        result: { error: 'pages_agent_cloud' },
        ms: 12.4
      })
    ).toBe('[Matrix] pages open page=connections agent=00000000 outcome=cloud_agent ms=12')
    expect(matrixPagesOpenLogLine({ page: '../x', agentPrincipal: undefined, result: { viewId: 'v' }, ms: 3 })).toBe(
      '[Matrix] pages open page=unknown agent=default outcome=opened ms=3'
    )
  })
})
