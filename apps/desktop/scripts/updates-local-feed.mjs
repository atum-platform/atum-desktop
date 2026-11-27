import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const electron = process.argv[2]
if (process.platform !== 'darwin' || !electron) {
  throw new Error('Pass the path to the Electron executable on a Mac.')
}
const scratch = await mkdtemp(path.join(tmpdir(), 'atum-update-feed-'))
const cacheName = path.basename(scratch)
const adapter = fileURLToPath(new URL('../electron/t3-updates/service.ts', import.meta.url))
const main = `
  import { app, BrowserWindow, ipcMain } from 'electron';
  import { createServer } from 'node:http';
  import { createHash } from 'node:crypto';
  import { readFile } from 'node:fs/promises';
  import { createAtumUpdates } from ${JSON.stringify(adapter)};
  const scratch = ${JSON.stringify(scratch)};
  app.setPath('userData', scratch);
  const payload = Buffer.from('isolated unsigned updater test payload');
  const digest = createHash('sha512').update(payload).digest('base64');
  const manifest = 'version: 1.1.0\\nfiles:\\n  - url: demo-arm64.zip\\n    sha512: ' + digest
    + '\\n    size: ' + payload.length + '\\npath: demo-arm64.zip\\nsha512: ' + digest + '\\n';
  const tracks = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/latest-mac.yml' || url.pathname === '/beta-mac.yml') {
      tracks.add(url.pathname);
      response.end(manifest);
    } else if (url.pathname === '/demo-arm64.zip') {
      response.end(payload);
    } else {
      response.writeHead(404).end();
    }
  });
  void (async () => {
  try {
    await app.whenReady();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const window = new BrowserWindow({ show: false, webPreferences: { preload: scratch + '/preload.cjs', sandbox: true } });
    await window.loadURL('data:text/html,<!doctype html><title>Update fixture</title>');
    for (const channel of ['latest', 'beta']) {
      let prepared = false;
      const service = createAtumUpdates({
        version: '1.0.0', packaged: true, supported: true, userData: scratch, resources: scratch,
        currentChannel: channel, feedUrl: 'http://127.0.0.1:' + server.address().port + '/',
        settings: { migrate: async () => ({ channel, applied: null }), getChannel: async () => channel, setChannel: async () => {} },
        native: {
          developmentConfigPath: scratch + '/dev-app-update.yml',
          stage: { prepare: async (file, version) => {
            if (version !== '1.1.0' || !payload.equals(await readFile(file))) throw new Error('Unexpected staged input');
            prepared = true;
          } },
          install: async () => { throw new Error('Unexpected installer call'); }
        },
        admit: async () => 'Local fixture never installs.',
        changed: () => {},
        log: console.log
      });
      ipcMain.handle('fixture:updates', () => service.state());
      if (!await service.start()) throw new Error('Updater initialization failed');
      await service.checkNow();
      for (let i = 0; i < 120 && service.state().status !== 'downloaded'; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const read = () => window.webContents.executeJavaScript('window.fixture.read()');
      if (!prepared || (await read()).downloadedVersion !== '1.1.0' || (await read()).status !== 'downloaded') {
        throw new Error('Renderer did not see a prepared update: ' + service.state().status);
      }
      await service.stop();
      ipcMain.removeHandler('fixture:updates');
    }
    if (tracks.size !== 2) throw new Error('Expected both generic feed filenames');
    console.log('PASS: latest and beta stock Mac transfer, staged callback, repeated renderer IPC reads');
    app.quit();
  } catch (error) {
    console.error(error.message);
    app.exit(1);
  } finally {
    server.close();
  }
  })();
`
try {
  await writeFile(path.join(scratch, 'package.json'), JSON.stringify({ name: 'atum-update-fixture', main: 'main.mjs', version: '1.0.0' }))
  await writeFile(path.join(scratch, 'dev-app-update.yml'),
    `provider: generic\nurl: http://127.0.0.1/\nupdaterCacheDirName: ${cacheName}\n`)
  await writeFile(path.join(scratch, 'preload.cjs'),
    "const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('fixture', { read: () => ipcRenderer.invoke('fixture:updates') });")
  await build({ stdin: { contents: main, resolveDir: path.dirname(adapter) }, outfile: path.join(scratch, 'main.mjs'), bundle: true,
    external: ['electron'], format: 'esm', platform: 'node', target: 'node22',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [scratch], { stdio: 'inherit', env })
    const timer = setTimeout(() => child.kill(), 45_000)
    child.once('error', reject)
    child.once('exit', (status, signal) => {
      clearTimeout(timer)
      if (signal) {console.error(`Electron fixture ended with ${signal}`)}
      resolve(status ?? 1)
    })
  })
  process.exitCode = code
} finally {
  await rm(path.join(homedir(), 'Library', 'Caches', cacheName), { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
}
