#!/usr/bin/env node
// Disposable G1 proof only. No feed, network, notarization, or owner app access.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, statfsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const repository = path.resolve(desktop, '../..')
const run = process.argv[2]
if (process.platform !== 'darwin' || !/^[a-z0-9]+$/.test(run ?? '')) throw Error('Supply a unique lowercase run id on macOS')
const identity = 'Anka Ventures Vietnam Company Limited (7D5FC62RXD)'
const work = path.join(os.tmpdir(), `atum-swap-gate-${run}`)
const target = `/Applications/AtumUpdaterTest-${run}.app`
const backup = path.join(work, 'previous.app')
const staged = path.join(work, 'new', `AtumUpdaterTest-${run}.app`)
const events = path.join(work, 'events.jsonl')
if (existsSync(work) || existsSync(target)) throw Error('Refusing to overwrite an existing gate run')
function command(exe, args) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(exe, args, { cwd: desktop, encoding: 'utf8', env })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.status !== 0) throw Error(`${exe} failed: ${result.status}`)
}
const source = `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const target = ${JSON.stringify(target)}, staged = ${JSON.stringify(staged)}, backup = ${JSON.stringify(backup)};
const events = ${JSON.stringify(events)}, trigger = ${JSON.stringify(path.join(work, 'swap'))};
app.setPath('userData', ${JSON.stringify(path.join(work, 'user-data'))});
const log = (event, extra={}) => fs.appendFileSync(events, JSON.stringify({ event, version: app.getVersion(), pid: process.pid, at: Date.now(), ...extra })+'\\n');
app.whenReady().then(async () => {
  const window = new BrowserWindow({width:580,height:230});
  await window.loadURL('data:text/html,'+encodeURIComponent('<h2>Atum disposable staged-swap gate</h2><p>Version '+app.getVersion()+'</p><p>No owner app or user data is used.</p>'));
  log('shown');
  if(app.getVersion()==='90.0.1') return;
  const timer=setInterval(() => {
    if(!fs.existsSync(trigger)) return;
    clearInterval(timer);
    window.destroy();
    const started=performance.now(); log('swap-start');
    try {
      fs.renameSync(target, backup); log('old-moved');
      try { fs.renameSync(staged,target); } catch(error) {fs.renameSync(backup,target); throw error;}
      log('swap-done',{ms:performance.now()-started});
      const waiter=spawn('/bin/sh',['-c','while kill -0 "$1" 2>/dev/null; do sleep 0.1; done; /usr/bin/open -n "$2"','atum-swap-launch',String(process.pid),target],{detached:true,stdio:'ignore'});
      waiter.unref(); app.exit(0);
    }catch(error){log('swap-failed',{error:String(error)}); app.exit(1);}
  },100);
});
`
for (const version of ['90.0.0', '90.0.1']) {
  const disk = statfsSync('/')
  if (disk.bavail * disk.bsize < 3 * 1024 ** 3) throw Error('STOP: less than 3 GiB free')
  const stage = path.join(work, `source-${version}`)
  mkdirSync(stage, { recursive: true })
  writeFileSync(path.join(stage, 'main.cjs'), source)
  writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: `atum-swap-gate-${run}`, version, main: 'main.cjs' }))
  const config = path.join(work, `builder-${version}.json`)
  writeFileSync(config, JSON.stringify({
    appId: `com.atum.updater-test.${run}`, productName: `AtumUpdaterTest-${run}`,
    electronVersion: '44.10.1', electronDist: path.join(repository, 'node_modules/electron/dist'),
    directories: { app: stage, output: path.join(work, version === '90.0.0' ? 'old' : 'new') },
    files: ['main.cjs','package.json'], npmRebuild: false, asar: true,
    mac: { identity, hardenedRuntime: true, notarize: false, entitlements: path.join(desktop,'electron/entitlements.mac.plist'), entitlementsInherit: path.join(desktop,'electron/entitlements.mac.inherit.plist'), target: 'dir' }
  }))
  command(path.join(repository, 'node_modules/.bin/electron-builder'), ['--config',config,'--mac','--arm64','--dir','--publish','never'])
}
// Builder puts directory targets under mac-arm64.
command('/bin/mv', [path.join(work,'new','mac-arm64',path.basename(target)), staged])
command('/bin/mv', [path.join(work,'old','mac-arm64',path.basename(target)),target])
for (const bundle of [target,staged]) command('/usr/bin/codesign',['--verify','--deep','--strict',bundle])
console.log(JSON.stringify({work,target,staged,backup,events,trigger:path.join(work,'swap')}))
