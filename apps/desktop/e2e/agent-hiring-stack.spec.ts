import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildAppEnv, createSandbox, launchDesktop } from './fixtures'
import { expect, test } from './test'

test.use({ trace: 'off', screenshot: 'off' })
test.setTimeout(300_000)
interface Fixture { schema: string; baseUrl: string; supabaseUrl: string; anonKey: string; email: string; password: string;
  account: string; employee: string; hireOffer: string; skill: string; offer: string; publicKey: string; receipts: string }
interface Hire { id: string; assistant_id: string; state: string; renewal_enabled: boolean }
interface BridgeWindow extends Window { hermesDesktop: {
  protons: { wallet(): Promise<{ balance_protons: number; held_protons: number; ai_protons_per_usd: number }> };
  store: { agentHires(account: string): Promise<Hire[]>; purchase(offer: string, version: number, key: string, account: string, assistant: string): Promise<unknown> }
} }
const reply = 'River Desk collections: Acme has USD 1,400 overdue across invoices A001 and A002.'

function noPrivateFiles(root: string) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)

    if (entry.isDirectory()) { noPrivateFiles(path) }
    else if (entry.isFile()) { expect(readFileSync(path).includes(Buffer.from('RIVER_DESK_PRIVATE_EMPLOYEE')), path).toBe(false) }
  }
}

// Only the named disposable local stack accepts this clock fixture. No remote
// database URL, account credential, production env or global reset is used.
function sql(statement: string): string {
  return execFileSync('docker', ['exec', '-i', 'supabase_db_atum-training-release-48ea', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-XqAt', '-v', 'ON_ERROR_STOP=1'],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

test('hire, use, stop renewal and rehire the same trained employee through the real stack', async () => {
  const fixturePath = process.env.ATUM_HIRING_DESKTOP_FIXTURE
  test.skip(!fixturePath, 'Requires the isolated monthly hiring acceptance server')
  const fixture = JSON.parse(readFileSync(fixturePath!, 'utf8')) as Fixture
  expect(fixture.schema).toBe('atum-training-desktop-fixture/1')
  expect(fixture.baseUrl).toBe('http://127.0.0.1:57330')
  expect(fixture.supabaseUrl).toBe('http://127.0.0.1:57321')
  expect(fixture.account).toMatch(/^[0-9a-f-]{36}$/)
  expect(fixture.employee).toMatch(/^acceptance\/[0-9a-f-]{36}$/)
  const sandbox = createSandbox('hiring-stack')
  writeFileSync(join(sandbox.hermesHome, 'config.yaml'), 'model:\n  default: binh-minh\n  provider: atum-managed\ndisplay:\n  language: en\n')

  const env = buildAppEnv(sandbox, { ATUM_PLATFORM_URL: fixture.baseUrl, NEXT_PUBLIC_SUPABASE_URL: fixture.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: fixture.anonKey, ATUM_PASSWORD_AUTH_ENABLED: 'true', NEXT_PUBLIC_GOOGLE_AUTH_ENABLED: 'false',
    ATUM_DEFAULT_MODEL: 'binh-minh', ATUM_STORE_DEV_ENTITLEMENT_PUBLIC_KEY: fixture.publicKey })

  const { app, page } = await launchDesktop(env, { productionFlags: process.platform === 'darwin' })
  page.on('console', message => { if (message.text().startsWith('[submit-drift-abort]')) { console.log(message.text()) } })
  let authenticated = false
  let failed = false

  try {
    const auth = page.locator('[data-atum-auth]')
    await expect(auth).toBeVisible({ timeout: 60_000 })
    await auth.locator('#atum-identifier').fill(fixture.email)
    await auth.locator('#atum-password').fill(fixture.password)
    await auth.getByRole('button', { name: /^(Sign in|Đăng nhập)$/ }).click()
    await expect(auth).toHaveCount(0, { timeout: 60_000 }); authenticated = true
    const gate = page.locator('[data-atum-username-gate]')
    await expect(page.locator('[data-atum-username-gate], [data-slot="composer-rich-input"][contenteditable="true"]').first()).toBeVisible({ timeout: 60_000 })

    if (await gate.isVisible()) { await gate.getByRole('button', { name: /^(Keep @|Giữ @)/ }).click() }
    await expect(page.locator('[data-slot="composer-rich-input"][contenteditable="true"]')).toBeVisible({ timeout: 60_000 })
    await page.locator('[data-atum-nav-discover]').click()
    await page.locator('[data-atum-shelf="agents"]').click()
    await expect(page.locator('[data-atum-shelf="agents"]')).toHaveAttribute('aria-current', 'page')
    const offer = page.locator(`[data-agent-offer="${fixture.employee}"]`)
    await expect(offer.getByRole('button', { name: /^(Hire|Thuê)$/ })).toBeEnabled({ timeout: 60_000 })
    const initial = await page.evaluate(() => (window as unknown as BridgeWindow).hermesDesktop.protons.wallet())
    await offer.getByRole('button', { name: /^(Hire|Thuê)$/ }).click()
    let dialog = page.getByRole('dialog')
    await dialog.getByLabel(/^(Employee name|Tên trợ lý)$/).fill('River Desk Alex')
    await expect(dialog.getByRole('button', { name: /^(Hire|Thuê)$/ })).toBeDisabled()
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: /^(Hire|Thuê)$/ }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await page.evaluate(account => (window as unknown as BridgeWindow).hermesDesktop.store.agentHires(account), fixture.account)).length,
      { timeout: 60_000 }).toBe(1)
    let hires = await page.evaluate(account => (window as unknown as BridgeWindow).hermesDesktop.store.agentHires(account), fixture.account)
    const hired = hires[0]!
    expect(hired.renewal_enabled).toBe(true)
    expect(hired.assistant_id).toMatch(/^[0-9a-f-]{36}$/)
    const card = page.locator(`[data-agent-hire="${hired.id}"]`)
    await expect(card).toContainText('River Desk Alex')
    await page.screenshot({ path: join(sandbox.root, 'hired-screen.png') })
    // The existing native training purchase path charges this employee once.
    await page.evaluate(async args => (window as unknown as BridgeWindow).hermesDesktop.store.purchase(args.offer, 1, crypto.randomUUID(), args.account, args.assistant),
      { offer: fixture.offer, account: fixture.account, assistant: hired.assistant_id })

    for (const round of [1, 2]) {
      await card.getByRole('button', { name: /^(Open|Mở)$/ }).click()
      const composer = page.locator('[data-slot="composer-rich-input"][contenteditable="true"]')
      await expect(composer).toBeVisible({ timeout: 30_000 })
      await composer.fill(`Prepare the collections brief, round ${round}.`)
      await composer.press('Enter')
      await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: 90_000 })
      await page.locator('[data-atum-nav-discover]').click()
      await page.locator('[data-atum-shelf="agents"]').click()

      if (round === 1) {
        await card.getByRole('button', { name: /^(Stop renewal|Dừng gia hạn)$/ }).click()
        await expect(card).toContainText(/Renewal stopped\.|Đã dừng gia hạn\./)
        // Lapse only this synthetic employee. A funded wallet cannot bypass it.
        sql(`update atum_private.agent_hires set period_start=now()-interval '2 months',period_end=now()-interval '1 month' where user_id='${fixture.account}' and id='${hired.id}';`)
        await page.locator('[data-atum-shelf="skills"]').click(); await page.locator('[data-atum-shelf="agents"]').click()
        await expect(card.getByRole('button', { name: /^(Rehire|Thuê lại)$/ })).toBeEnabled({ timeout: 30_000 })
        await card.getByRole('button', { name: /^(Rehire|Thuê lại)$/ }).click()
        dialog = page.getByRole('dialog')
        await expect(dialog.getByLabel(/^(Employee name|Tên trợ lý)$/)).toHaveValue('River Desk Alex')
        await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: /^(Hire|Thuê)$/ }).click()
        await expect(dialog).toHaveCount(0)
        await expect(card.getByRole('button', { name: /^(Stop renewal|Dừng gia hạn)$/ })).toBeEnabled({ timeout: 30_000 })
      }
    }

    hires = await page.evaluate(account => (window as unknown as BridgeWindow).hermesDesktop.store.agentHires(account), fixture.account)
    expect(hires).toHaveLength(1); expect(hires[0]!.assistant_id).toBe(hired.assistant_id)
    expect(sql(`select count(*) from atum_private.catalog_entitlements where user_id='${fixture.account}' and assistant_id='${hired.assistant_id}' and kind='skill' and state='active';`)).toBe('1')
    expect(sql(`select count(*) from atum_private.catalog_purchases where user_id='${fixture.account}' and kind='agent';`)).toBe('2')
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as BridgeWindow).hermesDesktop.protons.wallet())).held_protons).toBe(0)
    const wallet = await page.evaluate(() => (window as unknown as BridgeWindow).hermesDesktop.protons.wallet())
    const receipts = readFileSync(fixture.receipts, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    expect(receipts.filter(row => row.privateEmployee).length).toBe(2)
    expect(receipts.every(row => row.model === 'google/gemini-2.5-flash')).toBe(true)
    expect(wallet.balance_protons).toBe(Math.floor(initial.balance_protons - 2100 - receipts.reduce((total, row) => total + row.cost, 0) * wallet.ai_protons_per_usd))
    expect(sql(`select count(*) from atum_private.execution_model_pins p join atum_private.managed_execution_tasks t on t.id=p.task_id where t.user_id='${fixture.account}';`)).toBe('2')
  } catch (error) {
    failed = true
    console.log('Retained synthetic sandbox:', sandbox.root)

    if (authenticated) { console.log('Synthetic hiring acceptance state:', page.url(), await page.locator('body').innerText()) }
    throw error
  } finally { await app.close().catch(() => undefined);

 try { noPrivateFiles(sandbox.root) } finally { if (!failed) { sandbox.cleanup() } } }
})
