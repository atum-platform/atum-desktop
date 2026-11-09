import { describe, expect, it, vi } from 'vitest'

import { createMatrixPagesHubScope, matrixPagesHubRequest } from './pages-hub'

describe('native skills hub route allowlist', () => {
  it('forwards only the supported hub routes with a pinned profile and canonical query encoding', () => {
    expect(matrixPagesHubRequest({ path: '/api/skills/hub/sources' })).toEqual({
      path: '/api/skills/hub/sources?profile=default',
      method: 'GET'
    })
    expect(
      matrixPagesHubRequest({ path: '/api/skills/hub/search?q=hello%20world&source=skills-sh&limit=999' })
    ).toEqual({
      path: '/api/skills/hub/search?q=hello+world&source=skills-sh&limit=50&profile=default',
      method: 'GET'
    })
    expect(matrixPagesHubRequest({ path: '/api/skills/hub/preview?identifier=official%2Fpixel-art' })).toEqual({
      path: '/api/skills/hub/preview?identifier=official%2Fpixel-art&profile=default',
      method: 'GET'
    })
    expect(matrixPagesHubRequest({ path: '/api/skills/hub/scan?identifier=official%2Fpixel-art' })).toEqual({
      path: '/api/skills/hub/scan?identifier=official%2Fpixel-art&profile=default',
      method: 'GET'
    })
    expect(
      matrixPagesHubRequest({
        path: '/api/skills/hub/install',
        method: 'POST',
        body: { identifier: 'official/pixel-art' }
      })
    ).toEqual({
      path: '/api/skills/hub/install?profile=default',
      method: 'POST',
      body: { identifier: 'official/pixel-art' }
    })
  })

  it.each([
    '/api/skills/hub/sources?',
    '/api/skills/hub/sources?profile=default',
    '/api/skills/hub/search?q=one&q=two',
    '/api/skills/hub/search?limit=%',
    '/api/skills/hub/search?q=%00',
    '/api/skills/hub/search?source=not/a-source',
    '/api/skills/hub/preview?identifier=official%2Fpixel-art&profile=default',
    '/api/skills/hub/preview?identifier=',
    '/api/skills/hub/scan?identifier=',
    '/api/skills/hub/scan?identifier=one&identifier=two',
    '/api/skills/hub/scan?identifier=official/demo&profile=other',
    '/api/skills/hub/scan?identifier=%00',
    '/api/skills/hub/scan?identifier=%',
    `/api/skills/hub/scan?identifier=${'a'.repeat(513)}`,
    '/api/skills/hub%2Fpreview?identifier=official%2Fpixel-art',
    '/api/skills/hub/../install',
    '/api/actions/skills-install-demo-deadbeef/status?profile=default',
    '/api/actions/skills-install-demo-deadbeef/status?lines=-1',
    '/api/actions/skills-install-demo-deadbeef/status?lines=1&lines=2',
    '/api/actions/skills-install-demo-deadbeef/status?lines=1%0a'
  ])('rejects malformed, duplicate, unscoped, or traversing query/path input: %s', path => {
    expect(() => matrixPagesHubRequest({ path })).toThrow('pages_request_forbidden')
  })

  it.each([
    { path: '/api/skills/hub/install', method: 'POST', body: {} },
    { path: '/api/skills/hub/install', method: 'POST', body: { identifier: 'official/demo', profile: 'other' } },
    { path: '/api/skills/hub/install', method: 'GET' },
    { path: '/api/skills/hub/scan?identifier=official/demo', method: 'POST' },
    { path: '/api/skills/hub/scan?identifier=official/demo', body: { force: true } },
    { path: '/api/skills/hub/uninstall', method: 'POST', body: { name: 'demo' } },
    { path: '/api/skills/hub/update', method: 'POST' },
    { path: '/api/skills' },
    { path: '/api/cron/jobs' }
  ])('does not expand the existing pages surface: %#', request => {
    expect(() => matrixPagesHubRequest(request)).toThrow('pages_request_forbidden')
  })
})

describe('native skills hub scope', () => {
  it('confirms a scan separately and forwards the upstream verdict without granting action status', async () => {
    const response = { verdict: 'dangerous', policy: 'block', findings: ['real upstream findings'] }
    const confirm = vi.fn().mockResolvedValue(true)
    const forward = vi.fn().mockResolvedValue(response)
    const scope = createMatrixPagesHubScope({ confirm, isCurrent: () => true, forward })
    await expect(scope.request({ path: '/api/skills/hub/scan?identifier=official/demo' })).resolves.toBe(response)
    expect(confirm).toHaveBeenCalledWith('official/demo', 'scan')
    expect(forward).toHaveBeenCalledWith({
      path: '/api/skills/hub/scan?identifier=official%2Fdemo&profile=default',
      method: 'GET'
    })
    await expect(scope.request({ path: '/api/actions/skills-install-demo-deadbeef/status' })).rejects.toThrow(
      'pages_request_forbidden'
    )
    expect(forward).toHaveBeenCalledOnce()
  })

  it('cancelled scan does not forward, install or retain a verdict', async () => {
    const forward = vi.fn()
    const scope = createMatrixPagesHubScope({ confirm: () => false, isCurrent: () => true, forward })
    await expect(scope.request({ path: '/api/skills/hub/scan?identifier=official/demo' })).rejects.toThrow(
      'pages_hub_scan_cancelled'
    )
    expect(forward).not.toHaveBeenCalled()
  })

  it('fences a scan before confirmation, after confirmation and after a late upstream reply', async () => {
    let current = false

    const confirm = vi.fn().mockImplementation(() => {
      current = false

      return true
    })

    const forward = vi.fn().mockImplementation(() => {
      current = false

      return { policy: 'allow' }
    })

    const scope = createMatrixPagesHubScope({ confirm, isCurrent: () => current, forward })
    const request = { path: '/api/skills/hub/scan?identifier=official/demo' }
    await expect(scope.request(request)).rejects.toThrow('pages_agent_unavailable')
    expect(confirm).not.toHaveBeenCalled()
    current = true
    await expect(scope.request(request)).rejects.toThrow('pages_agent_unavailable')
    expect(forward).not.toHaveBeenCalled()
    current = true
    confirm.mockImplementation(() => true)
    await expect(scope.request(request)).rejects.toThrow('pages_agent_unavailable')
    expect(forward).toHaveBeenCalledOnce()
  })

  it('does not forward an install when native confirmation is cancelled', async () => {
    const forward = vi.fn()
    const scope = createMatrixPagesHubScope({ confirm: () => false, isCurrent: () => true, forward })

    await expect(
      scope.request({ path: '/api/skills/hub/install', method: 'POST', body: { identifier: 'official/demo' } })
    ).rejects.toThrow('pages_hub_install_cancelled')
    expect(forward).not.toHaveBeenCalled()
  })

  it('denies an install that becomes stale while confirmation is pending', async () => {
    let current = true

    let resolveConfirmation: (value: boolean) => void = () => {}

    const confirmation = new Promise<boolean>(resolve => {
      resolveConfirmation = resolve
    })

    const forward = vi.fn()
    const scope = createMatrixPagesHubScope({ confirm: () => confirmation, isCurrent: () => current, forward })

    const install = scope.request({
      path: '/api/skills/hub/install',
      method: 'POST',
      body: { identifier: 'official/demo' }
    })

    current = false
    resolveConfirmation(true)

    await expect(install).rejects.toThrow('pages_agent_unavailable')
    expect(forward).not.toHaveBeenCalled()
  })

  it('retains only a valid upstream-issued install action and rejects forged status names', async () => {
    const forward = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, pid: 101, name: 'skills-install-official-demo-deadbeef' })
      .mockResolvedValueOnce({ running: true })

    const scope = createMatrixPagesHubScope({ confirm: () => true, isCurrent: () => true, forward })

    await scope.request({ path: '/api/skills/hub/install', method: 'POST', body: { identifier: 'official/demo' } })
    await scope.request({ path: '/api/actions/skills-install-official-demo-deadbeef/status?lines=10' })
    await expect(scope.request({ path: '/api/actions/skills-install-other-cafebabe/status' })).rejects.toThrow(
      'pages_request_forbidden'
    )
    expect(forward).toHaveBeenCalledTimes(2)
    expect(forward.mock.calls[1][0]).toEqual({
      path: '/api/actions/skills-install-official-demo-deadbeef/status?lines=10&profile=default',
      method: 'GET'
    })
  })

  it('does not retain malformed upstream action names', async () => {
    const forward = vi.fn().mockResolvedValue({ ok: true, pid: 101, name: 'skills-uninstall-demo-deadbeef' })
    const scope = createMatrixPagesHubScope({ confirm: () => true, isCurrent: () => true, forward })

    await expect(
      scope.request({ path: '/api/skills/hub/install', method: 'POST', body: { identifier: 'official/demo' } })
    ).rejects.toThrow('pages_hub_invalid_action')
    await expect(scope.request({ path: '/api/actions/skills-install-demo-deadbeef/status' })).rejects.toThrow(
      'pages_request_forbidden'
    )
  })

  it('accepts the backend action name when its 48-character slug is truncated after a hyphen', async () => {
    const identifier = `${'a'.repeat(47)}/demo`
    const action = `skills-install-${'a'.repeat(47)}--deadbeef`
    const forward = vi.fn().mockResolvedValueOnce({ ok: true, pid: 101, name: action }).mockResolvedValueOnce({})
    const scope = createMatrixPagesHubScope({ confirm: () => true, isCurrent: () => true, forward })

    await scope.request({ path: '/api/skills/hub/install', method: 'POST', body: { identifier } })
    await scope.request({ path: `/api/actions/${action}/status` })
    expect(forward).toHaveBeenCalledTimes(2)
  })

  it.each([
    { ok: false, pid: 101, name: 'skills-install-demo-deadbeef' },
    { ok: true, pid: 0, name: 'skills-install-demo-deadbeef' },
    { ok: true, pid: Number.POSITIVE_INFINITY, name: 'skills-install-demo-deadbeef' }
  ])('does not grant status authority for an incomplete upstream install response %#', async response => {
    const forward = vi.fn().mockResolvedValue(response)
    const scope = createMatrixPagesHubScope({ confirm: () => true, isCurrent: () => true, forward })

    await expect(
      scope.request({ path: '/api/skills/hub/install', method: 'POST', body: { identifier: 'official/demo' } })
    ).rejects.toThrow('pages_hub_invalid_action')
    await expect(scope.request({ path: '/api/actions/skills-install-demo-deadbeef/status' })).rejects.toThrow(
      'pages_request_forbidden'
    )
  })

  it('isolates action authority between native scopes', async () => {
    const action = 'skills-install-official-demo-deadbeef'
    const firstForward = vi.fn().mockResolvedValue({ ok: true, pid: 101, name: action })
    const first = createMatrixPagesHubScope({ confirm: () => true, isCurrent: () => true, forward: firstForward })
    const secondForward = vi.fn()
    const second = createMatrixPagesHubScope({ confirm: () => true, isCurrent: () => true, forward: secondForward })

    await first.request({ path: '/api/skills/hub/install', method: 'POST', body: { identifier: 'official/demo' } })
    await expect(second.request({ path: `/api/actions/${action}/status` })).rejects.toThrow('pages_request_forbidden')
    expect(secondForward).not.toHaveBeenCalled()
  })
})

describe('selected-agent safe Hub update authority', () => {
  const route = '/api/skills/hub/update-safe'
  const single = { path: route, method: 'POST' as const, body: { name: 'demo' } }
  const all = { path: route, method: 'POST' as const, body: { all: true } }
  const action = 'skills-update-demo-deadbeef'

  it.each([single, all])('pins the selected agent profile and preserves the exact selector %#', request => {
    expect(matrixPagesHubRequest(request)).toEqual({ ...request, path: `${route}?profile=default` })
  })

  it.each([
    {},
    { all: false },
    { all: 'true' },
    { all: true, name: 'demo' },
    { name: 'demo', profile: 'other' },
    { name: 'demo', owner: 'other' },
    { name: 'demo', path: '/tmp/demo' },
    { name: '' },
    { name: ' demo' },
    { name: '-all' },
    { name: '.hub' },
    { name: '../demo' },
    { name: 'a/demo' },
    { name: 'a\\demo' },
    { name: 'a\u0085demo' },
    { name: 'a'.repeat(129) }
  ])('refuses ambiguous or caller-scoped updates %#', body => {
    expect(() => matrixPagesHubRequest({ ...single, body })).toThrow('pages_request_forbidden')
  })

  it.each([`${route}?profile=default`, `${route}?all=true`, `${route}?`])('refuses update query input %s', path => {
    expect(() => matrixPagesHubRequest({ ...single, path })).toThrow('pages_request_forbidden')
  })

  it.each([
    [single, 'demo', 'update', 'pages_hub_update_cancelled'],
    [all, 'all', 'update-all', 'pages_hub_update-all_cancelled']
  ] as const)('confirms and quietly cancels the exact maintenance scope %#', async (request, name, operation, code) => {
    const confirm = vi.fn().mockResolvedValue(false)
    const forward = vi.fn()
    const scope = createMatrixPagesHubScope({ confirm, forward, isCurrent: () => true })
    await expect(scope.request(request)).rejects.toThrow(code)
    expect(confirm).toHaveBeenCalledWith(name, operation)
    expect(forward).not.toHaveBeenCalled()
  })

  it.each([single, all])('fences updates before consent, after consent, and after the reply %#', async request => {
    let current = false

    const confirm = vi.fn(() => {
      current = false

      return true
    })

    const forward = vi.fn(async () => {
      current = false

      return { ok: true, pid: 42, name: action }
    })

    const scope = createMatrixPagesHubScope({ confirm, forward, isCurrent: () => current })
    await expect(scope.request(request)).rejects.toThrow('pages_agent_unavailable')
    expect(confirm).not.toHaveBeenCalled()
    current = true
    await expect(scope.request(request)).rejects.toThrow('pages_agent_unavailable')
    expect(forward).not.toHaveBeenCalled()
    current = true
    confirm.mockImplementation(() => true)
    await expect(scope.request(request)).rejects.toThrow('pages_agent_unavailable')
    current = true
    await expect(scope.request({ path: `/api/actions/${action}/status` })).rejects.toThrow('pages_request_forbidden')
  })

  it.each([single, all])('grants polling only to the update action actually issued in this scope %#', async request => {
    const forward = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, pid: 42, name: action })
      .mockResolvedValueOnce({ running: false, exit_code: 1 })

    const scope = createMatrixPagesHubScope({ confirm: () => true, forward, isCurrent: () => true })
    await scope.request(request)
    await expect(scope.request({ path: `/api/actions/${action}/status` })).resolves.toEqual({
      running: false,
      exit_code: 1
    })
    const other = createMatrixPagesHubScope({ confirm: () => true, forward, isCurrent: () => true })
    await expect(other.request({ path: `/api/actions/${action}/status` })).rejects.toThrow('pages_request_forbidden')
    await expect(scope.request({ path: '/api/actions/skills-update-other-cafebabe/status' })).rejects.toThrow(
      'pages_request_forbidden'
    )
  })

  it.each([
    { ok: true, pid: 42, name: 'skills-install-demo-deadbeef' },
    { ok: true, pid: 42, name: 'skills-archive-demo-deadbeef' },
    { ok: false, pid: 42, name: action },
    { ok: true, pid: 0, name: action },
    { ok: true, pid: 1.5, name: action },
    { ok: true, pid: 42, name: 'skills-update' }
  ])('rejects incomplete or wrong-operation action replies %#', async response => {
    const scope = createMatrixPagesHubScope({
      confirm: () => true,
      forward: async () => response,
      isCurrent: () => true
    })

    await expect(scope.request(single)).rejects.toThrow('pages_hub_invalid_action')
    await expect(scope.request({ path: `/api/actions/${action}/status` })).rejects.toThrow('pages_request_forbidden')
  })

  it('surfaces an unsupported safe runtime without forwarding a legacy update', async () => {
    const forward = vi.fn().mockRejectedValue(new Error('HTTP 404'))
    const scope = createMatrixPagesHubScope({ confirm: () => true, forward, isCurrent: () => true })
    await expect(scope.request(single)).rejects.toThrow('HTTP 404')
    expect(forward).toHaveBeenCalledOnce()
    expect(forward).toHaveBeenCalledWith(matrixPagesHubRequest(single))
  })
})

describe('selected-agent hub archive authority', () => {
  const request = { path: '/api/skills/hub/uninstall', method: 'POST' as const, body: { name: 'demo', archive: true } }
  const action = 'skills-archive-demo-deadbeef'

  it('only permits the explicit archive operation and pins the selected home profile', () => {
    expect(matrixPagesHubRequest(request)).toEqual({
      path: '/api/skills/hub/uninstall?profile=default',
      method: 'POST',
      body: { name: 'demo', archive: true }
    })

    for (const body of [
      { name: 'demo' },
      { name: 'demo', archive: false },
      { name: '../demo', archive: true },
      { name: 'a/demo', archive: true },
      { name: '.hub', archive: true },
      { name: 'demo', archive: true, profile: 'other' },
      { name: 'demo', archive: 'true' }
    ]) {
      expect(() => matrixPagesHubRequest({ ...request, body })).toThrow('pages_request_forbidden')
    }
  })

  it('confirms archive by name and polls only the action issued for that native scope', async () => {
    const confirm = vi.fn().mockResolvedValue(true)

    const forward = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, pid: 42, name: action })
      .mockResolvedValueOnce({ running: false, exit_code: 0 })

    const scope = createMatrixPagesHubScope({ confirm, forward, isCurrent: () => true })
    await scope.request(request)
    expect(confirm).toHaveBeenCalledWith('demo', 'archive')
    expect(forward).toHaveBeenCalledWith(matrixPagesHubRequest(request))
    await scope.request({ path: `/api/actions/${action}/status` })
    const other = createMatrixPagesHubScope({ confirm, forward, isCurrent: () => true })
    await expect(other.request({ path: `/api/actions/${action}/status` })).rejects.toThrow('pages_request_forbidden')
    await expect(scope.request({ path: '/api/actions/skills-uninstall-demo-deadbeef/status' })).rejects.toThrow(
      'pages_request_forbidden'
    )
    expect(forward).toHaveBeenCalledTimes(2)
  })

  it('never grants archive status authority for an install action returned by the backend', async () => {
    const forward = vi.fn().mockResolvedValue({ ok: true, pid: 42, name: 'skills-install-demo-deadbeef' })
    const scope = createMatrixPagesHubScope({ confirm: () => true, forward, isCurrent: () => true })
    await expect(scope.request(request)).rejects.toThrow('pages_hub_invalid_action')
    await expect(scope.request({ path: '/api/actions/skills-install-demo-deadbeef/status' })).rejects.toThrow(
      'pages_request_forbidden'
    )
    expect(forward).toHaveBeenCalledOnce()
  })

  it('cancelled archive does not reach the actual agent', async () => {
    const forward = vi.fn()
    const scope = createMatrixPagesHubScope({ confirm: () => false, forward, isCurrent: () => true })
    await expect(scope.request(request)).rejects.toThrow('pages_hub_archive_cancelled')
    expect(forward).not.toHaveBeenCalled()
  })

  it('rejects an account switch before or during confirmation and discards late action authority', async () => {
    let current = false

    const confirm = vi.fn(() => {
      current = false

      return true
    })

    const forward = vi.fn(() => {
      current = false

      return Promise.resolve({ ok: true, pid: 42, name: action })
    })

    const scope = createMatrixPagesHubScope({ confirm, forward, isCurrent: () => current })
    await expect(scope.request(request)).rejects.toThrow('pages_agent_unavailable')
    expect(confirm).not.toHaveBeenCalled()
    current = true
    await expect(scope.request(request)).rejects.toThrow('pages_agent_unavailable')
    expect(forward).not.toHaveBeenCalled()
    current = true
    confirm.mockImplementation(() => true)
    await expect(scope.request(request)).rejects.toThrow('pages_agent_unavailable')
    current = true
    await expect(scope.request({ path: `/api/actions/${action}/status` })).rejects.toThrow('pages_request_forbidden')
    expect(forward).toHaveBeenCalledOnce()
  })
})
