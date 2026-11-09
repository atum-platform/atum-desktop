import { configure } from '@testing-library/react'

// React 19 + Testing Library 16: opt into the act environment so render(),
// fireEvent(), and findBy* queries automatically flush state updates without
// spurious "not wrapped in act(...)" warnings.
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// findBy*/waitFor default to a 1000ms deadline — too tight for async-heavy
// panels (radix menus, refetch chains) when the full suite runs under xdist
// CPU contention in CI. Success still resolves the instant the node appears;
// the wider deadline only absorbs a starved runner, killing timing flakes.
configure({ asyncUtilTimeout: 5000 })

// Team space keeps a durable last-known-good copy of the company directory and channel lists
// (storage + module-level atoms). Reset it per test so one test's companies never seed the next.
// The stores load once here so the reset itself is synchronous and never delays teardown.
if (typeof window !== 'undefined') {
  const { afterEach } = await import('vitest')
  const [{ $companyDirectories }, { $companyChannels }, { resetMatrixHandleContactsForTest }] = await Promise.all([
    import('./src/matrix/team-space/directory-store'),
    import('./src/matrix/team-space/channels-store'),
    import('./src/matrix/person-handle-contacts')
  ])
  afterEach(() => {
    // Some suites delete or stub `window` mid-test; only touch storage that is still there.
    const storage = typeof window === 'undefined' ? undefined : window.localStorage
    for (const key of storage ? Object.keys(storage) : []) {
      if (key.startsWith('atum.team-space.directory.v1:') || key.startsWith('atum.team-space.channels.v1:') ||
        key === 'atum.team-space.cache-account.v1') {
        storage?.removeItem(key)
      }
    }
    $companyDirectories.set({})
    $companyChannels.set({})
    // The handle-contacts resolver pools asks on a timer: a read queued in one test must never
    // reach the next test's bridge.
    resetMatrixHandleContactsForTest()
  })
}
