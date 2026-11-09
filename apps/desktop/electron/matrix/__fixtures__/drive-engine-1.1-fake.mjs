// Synthetic protocol peer for the spawned-child integration test; no network or credentials.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

const [issuer, origin] = process.argv.slice(2)
const offered = ['progress', 'sync', 'quota', 'exclusions', 'trash']
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
send({ kind: 'hello', protocol: 1, issuer, origin, taskFiles: false, features: offered })
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line)
  if (command.kind === 'start') {
    writeFileSync(
      path.join(command.root, '.atum-drive-binding.json'),
      JSON.stringify({
        version: 1,
        canonicalRoot: command.root,
        issuer,
        subject: command.subject,
        origin,
        journal: '.atum-drive-journal.db',
        space: 'synthetic$personal'
      })
    )
    send({ kind: 'state', state: 'ready' })
    for (const feature of command.features ?? []) {
      if (feature === 'sync') send({ kind: 'sync', lastSyncAt: 1791281400000, conflicts: 1, errors: 2, excluded: 3 })
      if (feature === 'quota')
        send({ kind: 'quota', total: 1073741824, used: 300000000, remaining: 773741824, state: 'normal' })
      if (feature === 'progress')
        send({
          kind: 'progress',
          active: true,
          files: { done: 12, total: 40 },
          bytes: { done: 3, total: 10 },
          etaSeconds: 60,
          direction: 'mixed'
        })
      if (feature === 'exclusions')
        send({ kind: 'exclusions', patterns: ['token', '.env', '.git', 'node_modules', '*.synthetic'] })
    }
  } else if (['stop', 'forget', 'cleanup'].includes(command.kind)) {
    send({ kind: 'state', state: 'disconnected' })
    process.exit(0)
  }
})
