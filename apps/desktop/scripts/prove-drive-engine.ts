import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { MatrixDrive } from '../electron/matrix/drive'
import { selectMatrixDriveEngine } from '../electron/matrix/drive-engine'

/** Local acceptance only: issuer/subject facts, never a copied bearer. */
const [manifest, ownerFile, output] = process.argv.slice(2)

if (!manifest || !ownerFile || !output) {
  throw new Error('Usage: prove-drive-engine MANIFEST OWNER_FACTS OUTPUT_DIRECTORY')
}
const facts = JSON.parse(readFileSync(ownerFile, 'utf8')) as { issuer: string; subject: string }
const engine = selectMatrixDriveEngine(path.resolve(manifest), facts.issuer)
const home = path.resolve(output)
mkdirSync(home, { recursive: true, mode: 0o700 })
const root = path.join(home, 'Files')
mkdirSync(root, { recursive: true, mode: 0o700 })
const store = new Map<string, string>()
let previous = ''
let ready = false
let settle!: () => void
const completed = new Promise<void>(resolve => {
  settle = resolve
})

const drive = new MatrixDrive({
  owner: () => ({ ...facts, generation: 1 }),
  engine,
  userData: home,
  store: {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value)
    }
  },
  chooseFolder: async () => root,
  openExternal: async url => {
    writeFileSync(path.join(home, 'authorization.private'), url, { mode: 0o600 })
  },
  openPath: async () => {
    throw new Error('No native file opening in this headless acceptance harness')
  },
  changed: view => {
    if (view.state !== previous) {
      console.log(JSON.stringify({ state: view.state }))
      previous = view.state
    }

    if (!ready && view.state === 'ready' && view.rows.length) {
      ready = true
      settle()
    }
  }
})

const timeout = setTimeout(() => settle(), 12 * 60_000)
await drive.connect()
await completed
clearTimeout(timeout)
const view = await drive.read()

const receipt = {
  schema: 'atum.drive.integrated-native-engine/1',
  observedAt: new Date().toISOString(),
  state: view.state,
  rowCount: view.rows.length,
  fileNames: view.rows.map(row => row.name),
  freshEngineOAuth: true,
  credentialsInRenderer: false,
  localRootSelectedByHarness: true,
  canonicalAppUiAcceptance: false,
  signedDistribution: false,
  engineBinarySha256: createHash('sha256').update(readFileSync(engine.binary)).digest('hex'),
  nativeAdapterSha256: createHash('sha256')
    .update(readFileSync(new URL('../electron/matrix/drive.ts', import.meta.url)))
    .digest('hex')
}

writeFileSync(path.join(home, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify(receipt))
await drive.dispose()

if (view.state !== 'ready' || !view.rows.length) {
  process.exitCode = 1
}
