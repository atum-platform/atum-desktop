import { act, render, screen, waitFor } from '@testing-library/react'
import type { WritableAtom } from 'nanostores'
import { beforeEach, expect, test, vi } from 'vitest'

const routes = vi.fn()

vi.mock('@/lib/atum-app-surfaces', () => ({
  atumAppSurfaceClient: () => ({ routes }),
  isAppSurfaceFailure: (value: unknown) => typeof value === 'object' && value !== null && 'error' in value
}))
vi.mock('@/store/atum-messaging', async () => {
  const { atom } = await import('nanostores')

  return { $atumAccountScopeId: atom('account-1') }
})

const { resetRememberedAppRoutesForTests, useAppRoutes } = await import('./use-app-routes')
const { $atumAccountScopeId } = await import('@/store/atum-messaging')
const accountScope = $atumAccountScopeId as WritableAtom<string | null>

/**
 * Records what the hook answers on every render, not just after effects have
 * settled. The bug lived in the render between the app changing and the
 * clearing effect running, which a DOM assertion cannot see because the test
 * renderer flushes effects first.
 */
function Probe({ app, seen }: { app: string; seen: string[] }) {
  const { routes } = useAppRoutes(app)

  seen.push(`${app}:${routes ? routes.app : 'none'}`)

  return <span data-testid="answer">{routes ? routes.app : 'none'}</span>
}

beforeEach(() => {
  accountScope.set('account-1')
  routes.mockReset()
  resetRememberedAppRoutesForTests()
})

test('A → B → A cannot display or cache a stale owner projection', async () => {
  const pending: Array<(value: unknown) => void> = []
  routes.mockImplementation(() => new Promise(resolve => pending.push(resolve)))

  function OwnerProbe() {
    const { routes: answer } = useAppRoutes('moon')

    return <span data-testid="owner">{answer?.participant?.ownerDisplayName ?? 'none'}</span>
  }

  render(<OwnerProbe />)
  await act(async () => { accountScope.set('account-2') })
  await act(async () => { accountScope.set('account-1') })
  const answer = (owner: string) => ({ app: 'moon', routes: [], launch: false, participant: { kind: 'app', id: 'moon-id', displayName: 'Moon', ownerUserId: 'account-1', ownerDisplayName: owner } })
  await act(async () => { pending[0](answer('Stale Alice')); pending[1](answer('Bob')) })
  expect(screen.getByTestId('owner').textContent).toBe('none')
  await act(async () => { pending[2](answer('Current Alice')) })
  expect(screen.getByTestId('owner').textContent).toBe('Current Alice')
})

/**
 * The DM view pins a conversation's app menu from whatever this hook hands it.
 * Handing back the previous app's routes for even one render is what let one
 * conversation end up pinning another app's menu, so the hook must never
 * answer for an app it was not asked about.
 */
test('never answers with the previous app while a new one is resolving', async () => {
  const pending: Array<(value: unknown) => void> = []

  routes.mockImplementation((app: string) => new Promise(resolve => {
    pending.push(() => resolve({ app, items: [] }))
  }))

  const seen: string[] = []
  const view = render(<Probe app="moon" seen={seen} />)

  pending[0]?.(undefined)
  await waitFor(() => expect(screen.getByTestId('answer').textContent).toBe('moon'))

  // Andy's conversation opens. Andy's routes have not arrived yet.
  seen.length = 0
  view.rerender(<Probe app="andy" seen={seen} />)

  // Not one render for Andy may carry Moon's answer: the DM view pins from
  // exactly this value, in exactly this render.
  expect(seen.filter(entry => entry !== 'andy:none')).toEqual([])

  pending[1]?.(undefined)
  await waitFor(() => expect(screen.getByTestId('answer').textContent).toBe('andy'))
})

test('a failure leaves no answer behind', async () => {
  routes.mockResolvedValueOnce({ error: 'app_unavailable' })
  render(<Probe app="moon" seen={[]} />)

  await waitFor(() => expect(routes).toHaveBeenCalledWith('moon'))
  expect(screen.getByTestId('answer').textContent).toBe('none')
})

/**
 * Main fetches the manifest over the network, so returning to an app used to
 * leave its panel without a menu for the length of that round trip. The panel
 * filled that gap with the generic launcher, which looks exactly like the
 * previous conversation's workspace and stays clickable.
 */
test('an app already seen in this window renders its menu on the first render', async () => {
  routes.mockResolvedValue({ app: 'tarot', items: [] })

  const first: string[] = []
  const view = render(<Probe app="tarot" seen={first} />)

  await waitFor(() => expect(screen.getByTestId('answer').textContent).toBe('tarot'))
  view.unmount()

  const second: string[] = []
  render(<Probe app="tarot" seen={second} />)

  expect(second[0]).toBe('tarot:tarot')
})

test('an app that stops answering drops the menu it was remembering', async () => {
  routes.mockResolvedValue({ app: 'ben', items: [] })

  const view = render(<Probe app="ben" seen={[]} />)

  await waitFor(() => expect(screen.getByTestId('answer').textContent).toBe('ben'))
  view.unmount()

  routes.mockResolvedValue({ error: 'app_unavailable' })
  render(<Probe app="ben" seen={[]} />)

  await waitFor(() => expect(screen.getByTestId('answer').textContent).toBe('none'))
})
