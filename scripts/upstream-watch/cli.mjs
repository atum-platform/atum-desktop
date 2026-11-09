#!/usr/bin/env node
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { buildReport, createLiveFetchers, loadState, renderMarkdown, resolvePath, saveState } from './core.mjs'

function usage() {
  return `Usage: node scripts/upstream-watch/cli.mjs [options]

Options:
  --root <path>                 Atum repository root (default: current directory)
  --repo <name>=<path>          Optional source repository, e.g. atum-platform=/path
  --state <path>                Explicit durable state file (default: ~/.local/state/atum/upstream-watch.json)
  --format <json|markdown>      Report format (default: markdown)
  --output <path>               Write report to a file instead of stdout
  --offline                     Resolve local pins and retain state without network calls
  --help                        Show this help
`
}

function parseArgs(argv) {
  const options = { root: process.cwd(), repositories: {}, format: 'markdown', state: join(homedir(), '.local', 'state', 'atum', 'upstream-watch.json'), offline: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help') options.help = true
    else if (arg === '--offline') options.offline = true
    else if (arg === '--root' || arg === '--state' || arg === '--format' || arg === '--output' || arg === '--repo') {
      const value = argv[++index]
      if (!value) throw new Error(`${arg} requires a value`)
      if (arg === '--root') options.root = resolve(value)
      else if (arg === '--state') options.state = resolve(value)
      else if (arg === '--format') options.format = value
      else if (arg === '--output') options.output = resolve(value)
      else {
        const delimiter = value.indexOf('=')
        if (delimiter < 1 || delimiter === value.length - 1) throw new Error('--repo must be name=/absolute/or/relative/path')
        options.repositories[value.slice(0, delimiter)] = resolve(value.slice(delimiter + 1))
      }
    } else throw new Error(`unknown option: ${arg}`)
  }
  if (!['json', 'markdown'].includes(options.format)) throw new Error('--format must be json or markdown')
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) { process.stdout.write(usage()); return }
  const inventoryPath = join(options.root, 'docs/atum/upstreams.json')
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'))
  const statePath = resolvePath(options.root, options.state)
  const report = await buildReport({
    repoRoot: options.root,
    inventory,
    repositories: options.repositories,
    previousState: await loadState(statePath),
    fetchers: await createLiveFetchers(),
    offline: options.offline
  })
  await saveState(statePath, report.state)
  const output = options.format === 'json' ? `${JSON.stringify({ ...report, stateFile: statePath }, null, 2)}\n` : renderMarkdown(report)
  if (options.output) await writeFile(options.output, output, 'utf8')
  else process.stdout.write(output)
}

if (process.argv[1] && basename(process.argv[1]) === 'cli.mjs') {
  main().catch(error => { process.stderr.write(`upstream-watch: ${error.message}\n`); process.exitCode = 1 })
}
