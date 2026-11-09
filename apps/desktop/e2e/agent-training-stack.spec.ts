import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildAppEnv, createSandbox, launchDesktop } from './fixtures'
import { expect, test } from './test'

// Actual GoTrue, PostgREST, Next routes, Electron IPC and Hermes; only inference
// is a fixture. Each run requires a fresh desktop-environment.mjs account.
// Never record sign-in credentials in a Playwright trace or screenshot.
test.use({ trace: 'off', screenshot: 'off' })
test.setTimeout(300_000)

interface TrainingFixture {
  schema: string
  baseUrl: string
  supabaseUrl: string
  anonKey: string
  email: string
  password: string
  account: string
  skill: string
  offer: string
  publicKey: string
  receipts: string
}

// Narrow read-only projections of the existing native bridge. The E2E TS
// project intentionally does not compile renderer implementation modules.
interface ProtonWallet {
  balance_protons: number
  held_protons: number
  ai_protons_per_usd: number
}
interface AtumStoreCatalogWire {
  entitlements: Array<{ id: string; state: string; assistant_id: string | null; assistant_identity_id: string | null }>
}
interface TrainingWindow extends Window {
  hermesDesktop: {
    protons: { wallet: () => Promise<ProtonWallet> }
    store: { catalog: () => Promise<AtumStoreCatalogWire> }
  }
}

interface ProviderReceipt {
  id: string
  model: string
  privateTraining: boolean
  cost: number
}

const reply = 'River Desk collections: Acme has USD 1,400 overdue across invoices A001 and A002.'
const marker = 'RIVER_DESK_PRIVATE_TRAINING'

function receipts(path: string): ProviderReceipt[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function assertNoPrivateSource(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) { assertNoPrivateSource(path) }
    else if (entry.isFile()) { expect(readFileSync(path).includes(Buffer.from(marker)), path).toBe(false) }
  }
}

test('teach once, use training, then restore the same employee on another device', async () => {
  const fixturePath = process.env.ATUM_TRAINING_DESKTOP_FIXTURE

  test.skip(!fixturePath, 'Requires a fresh isolated platform desktop-environment.mjs acceptance server')
  const fixture = JSON.parse(readFileSync(fixturePath!, 'utf8')) as TrainingFixture

  expect(fixture.schema).toBe('atum-training-desktop-fixture/1')
  expect(fixture.baseUrl).toBe('http://127.0.0.1:57330')
  expect(fixture.supabaseUrl).toBe('http://127.0.0.1:57321')
  let trainedAssistant = ''
  let trainedIdentity = ''
  let balanceAfterFirstDevice = 0
  let initialBalance = 0

  for (const device of [1, 2]) {
    await test.step(`Device ${device}: real sign-in, training and accounted task`, async () => {
      const sandbox = createSandbox('training-stack')

      writeFileSync(join(sandbox.hermesHome, 'config.yaml'),
        'model:\n  default: binh-minh\n  provider: atum-managed\ndisplay:\n  language: en\n', 'utf8')

      const env = buildAppEnv(sandbox, {
        ATUM_PLATFORM_URL: fixture.baseUrl,
        NEXT_PUBLIC_SUPABASE_URL: fixture.supabaseUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: fixture.anonKey,
        ATUM_PASSWORD_AUTH_ENABLED: 'true',
        NEXT_PUBLIC_GOOGLE_AUTH_ENABLED: 'false',
        ATUM_DEFAULT_MODEL: 'binh-minh',
        ATUM_STORE_DEV_ENTITLEMENT_PUBLIC_KEY: fixture.publicKey,
      })

      const { app, page } = await launchDesktop(env, { productionFlags: process.platform === 'darwin' })
      let authenticated = false

      try {
        const auth = page.locator('[data-atum-auth]')

        await expect(auth).toBeVisible({ timeout: 60_000 })
        await auth.locator('#atum-identifier').fill(fixture.email)
        await auth.locator('#atum-password').fill(fixture.password)
        await auth.getByRole('button', { name: /^(Sign in|Đăng nhập)$/ }).click()
        await expect(auth).toHaveCount(0, { timeout: 60_000 })
        authenticated = true
        const usernameGate = page.locator('[data-atum-username-gate]')

        await expect(usernameGate).toBeVisible()
        await usernameGate.getByRole('button', { name: /^(Keep @|Giữ @)/ }).click()
        await expect(usernameGate).toHaveCount(0)
        await expect(page.locator('[data-slot="composer-rich-input"][contenteditable="true"]')).toBeVisible({ timeout: 60_000 })
        await page.locator('[data-atum-nav-discover]').click()
        await page.locator('[data-atum-shelf="skills"]').click()
        const entry = page.locator(`[data-skill-row="cloud/${fixture.skill}"]`)

        await expect(entry).toBeVisible({ timeout: 30_000 })
        const walletBefore = await page.evaluate(() => (window as unknown as TrainingWindow).hermesDesktop.protons.wallet())
        const catalogBefore = await page.evaluate(() => (window as unknown as TrainingWindow).hermesDesktop.store.catalog())

        if (device === 1) {
          initialBalance = walletBefore.balance_protons
          expect(catalogBefore.entitlements.filter(grant => grant.id === fixture.skill)).toEqual([])
          await entry.getByRole('button').last().click()
          const dialog = page.getByRole('dialog')

          await expect(dialog.getByRole('radio', { checked: true })).toBeVisible()
          await dialog.getByRole('button', { name: /^(Teach|Train|Đào tạo)/ }).click()
          await dialog.getByRole('button', { name: /^(Buy|Purchase|Mua)/ }).click()
          await expect(dialog.getByRole('button', { name: /^(Try|Thử)/ })).toBeVisible({ timeout: 30_000 })
          const catalog = await page.evaluate(() => (window as unknown as TrainingWindow).hermesDesktop.store.catalog())
          const grant = catalog.entitlements.find(candidate => candidate.id === fixture.skill)!

          expect(grant.state).toBe('active')
          trainedAssistant = grant.assistant_id!
          trainedIdentity = grant.assistant_identity_id!
          expect(trainedAssistant).toBeTruthy()
          expect(trainedIdentity).toBeTruthy()
          expect((await page.evaluate(() => (window as unknown as TrainingWindow).hermesDesktop.protons.wallet())).balance_protons)
            .toBe(walletBefore.balance_protons - 100)
          await dialog.getByRole('button', { name: /^(Try|Thử)/ }).click()
        } else {
          const grant = catalogBefore.entitlements.find(candidate => candidate.id === fixture.skill)!

          expect(grant.assistant_id).toBe(trainedAssistant)
          expect(grant.assistant_identity_id).toBe(trainedIdentity)
          expect(walletBefore.balance_protons).toBe(balanceAfterFirstDevice)
          await entry.getByRole('button', { name: /^(Try|Thử)$/ }).click()
        }

        const composer = page.locator('[data-slot="composer-rich-input"][contenteditable="true"]')

        await expect(composer).toBeVisible({ timeout: 30_000 })
        await expect(composer).toContainText('Prepare a River Desk collections brief.')
        const previousReceipts = receipts(fixture.receipts).length

        await composer.press('Enter')
        await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: 90_000 })
        // The normal title helper runs after the main response. It must be
        // accounted for separately and must not inherit private training.
        await expect.poll(() => receipts(fixture.receipts).slice(previousReceipts)
          .some(call => !call.privateTraining), { timeout: 30_000 }).toBe(true)
        const calls = receipts(fixture.receipts).slice(previousReceipts)

        expect(calls.some(call => call.privateTraining)).toBe(true)
        expect(calls.every(call => call.model === 'google/gemini-2.5-flash')).toBe(true)
        await expect.poll(async () => (await page.evaluate(() => (window as unknown as TrainingWindow).hermesDesktop.protons.wallet())).held_protons,
          { timeout: 30_000 }).toBe(0)
        const walletAfter = await page.evaluate(() => (window as unknown as TrainingWindow).hermesDesktop.protons.wallet())
        expect(walletAfter.held_protons).toBe(0)
        // The public wallet displays whole Protons. Sum all run receipts before
        // flooring, so fractional usage is never rounded once per device.
        expect(walletAfter.balance_protons).toBe(Math.floor(initialBalance - 100 -
          receipts(fixture.receipts).reduce((total, call) => total + call.cost, 0) * walletAfter.ai_protons_per_usd))
        balanceAfterFirstDevice = walletAfter.balance_protons
        expect(await page.locator('body').innerText()).not.toContain(marker)
      } catch (error) {
        if (authenticated) { console.log('Visible synthetic acceptance state:', await page.locator('body').innerText()) }
        throw error
      } finally {
        await app.close().catch(() => undefined)

        try { assertNoPrivateSource(sandbox.root) } finally { sandbox.cleanup() }
      }
    })
  }
})
