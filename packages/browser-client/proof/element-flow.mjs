// Drive the unmodified, pinned stock client on its own disposable profile/device.
import { createHash, X509Certificate } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { browserTools } from './browser-tools.mjs'

const runtime = join(dirname(fileURLToPath(import.meta.url)), '.runtime')
if (!lstatSync(runtime).isDirectory() || lstatSync(runtime).isSymbolicLink() || JSON.parse(readFileSync(join(runtime, 'owner.json'), 'utf8')).project !== 'atum-cx-browser-proof') throw new Error('owned_runtime_required')
const profile = join(runtime, 'stock-element-profile')
const account = JSON.parse(readFileSync(join(runtime, 'account-v2.json'), 'utf8'))
const { chromium, executablePath } = browserTools()
const cert = new X509Certificate(readFileSync(join(runtime, 'tls/server.pem')))
const spki = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
mkdirSync(profile, { recursive: true, mode: 0o700 })
if (lstatSync(profile).isSymbolicLink()) throw new Error('profile_symlink_refused')
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath,
  args: [`--ignore-certificate-errors-spki-list=${spki}`]
})
const page = await context.newPage()
const input = createInterface({ input: process.stdin, terminal: false })
const failures = []
async function summary() {
  console.log(JSON.stringify(await page.evaluate(() => ({
    origin: location.origin, pathClass: location.pathname.split('/').slice(0, 2).join('/'),
    publicRedirect: (() => { const value = new URL(location.href).searchParams.get('redirect_uri'); if (!value) return null; const target = new URL(value); return target.origin === 'http://localhost:22911' ? target.origin + target.pathname : 'unexpected_origin' })(),
    headings: Array.from(document.querySelectorAll('h1,h2,[role=heading]')).map(node => node.textContent),
    inputs: Array.from(document.querySelectorAll('input,textarea,[contenteditable=true]')).map(node => ({ name: node.name, type: node.type, placeholder: node.placeholder, label: node.getAttribute('aria-label'), role: node.getAttribute('role') })),
    buttons: Array.from(document.querySelectorAll('button,[role=button],a')).map(node => ({ role: node.tagName === 'A' ? 'link' : 'button', name: node.textContent?.trim() || node.getAttribute('aria-label') })).filter(node => node.name).slice(0, 60)
  }))))
}
try {
  await page.goto('http://localhost:22911', { waitUntil: 'domcontentloaded' })
  console.log('Stock Element disposable controller ready.')
  for await (const line of input) {
    const command = line.trim()
    try {
      if (command === 'exit') break
      if (command === 'home') {
        await page.goto('http://localhost:22911', { waitUntil: 'domcontentloaded' })
      } else if (command.startsWith('click|')) {
        const [, role, name] = command.split('|')
        if (!['button', 'link'].includes(role)) throw new Error('role_refused')
        await page.getByRole(role, { name, exact: true }).click()
        await page.waitForLoadState('domcontentloaded')
      } else if (command === 'mas-login') {
        if (new URL(page.url()).origin !== 'https://localhost:22981') throw new Error('origin_refused')
        await page.locator('input[name="username"]').fill(account.username)
        await page.locator('input[name="password"]').fill(account.password)
        await page.getByRole('button', { name: 'Continue', exact: true }).click()
        await page.waitForLoadState('domcontentloaded')
      } else if (command === 'restore-key') {
        if (new URL(page.url()).origin !== 'http://localhost:22911') throw new Error('origin_refused')
        const key = readFileSync(join(runtime, 'recovery-key'), 'utf8')
        await page.locator('input[type="password"]').fill(key)
        console.log(JSON.stringify({ privateRecoveryKeyEntered: true }))
      } else if (command === 'room-name') {
        await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Disposable encrypted browser proof')
      } else if (command === 'redirect-check') {
        if (new URL(page.url()).origin !== 'https://localhost:22981') throw new Error('origin_refused')
        const auth = new URL(page.url())
        const redirect = new URL(auth.searchParams.get('redirect_uri'))
        console.log(JSON.stringify({ expectedClient: auth.searchParams.get('client_id') === '01ARZ3NDEKTSV4RRFFQ69G5FAW', exactRedirect: redirect.href === 'http://localhost:22911/?no_universal_links=true', queryKeys: [...redirect.searchParams.keys()], fragmentIsEmpty: !redirect.hash, fragmentRoute: /^#[/a-z_-]+$/.test(redirect.hash) ? redirect.hash : null }))
      } else if (command === 'send-one' || command === 'send-two') {
        if (new URL(page.url()).origin !== 'http://localhost:22911') throw new Error('origin_refused')
        const composer = page.locator('[contenteditable="true"][role="textbox"]')
        await composer.fill(command === 'send-one' ? 'Atum disposable encrypted proof message one' : 'Atum disposable encrypted proof message two')
        await composer.press('Enter')
      } else if (command !== 'status') throw new Error('command_refused')
      await summary()
    } catch {
      const step = command.startsWith('click|') ? 'click' : ['home', 'mas-login', 'restore-key', 'room-name', 'redirect-check', 'send-one', 'send-two', 'status'].includes(command) ? command : 'command_refused'
      failures.push(step)
      console.log(JSON.stringify({ step, status: 'failed', disposableStatePreserved: true }))
    }
  }
} finally {
  input.close()
  await context.close()
  console.log(JSON.stringify({ stockControllerClosed: true, failedSteps: failures }))
}
