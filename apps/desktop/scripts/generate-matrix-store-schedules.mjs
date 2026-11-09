#!/usr/bin/env node
/**
 * Writes shared/matrix-store-schedules.ts's spec table from the shelf's blueprint
 * frontmatter (docs/shelf/agents/<agent>/skills/atum-<job>/SKILL.md,
 * `metadata.hermes.blueprint`, read as tools/blueprints.py parse_blueprint reads it).
 *
 *   node scripts/generate-matrix-store-schedules.mjs          # print the table
 *   node scripts/generate-matrix-store-schedules.mjs --write  # rewrite the table in place
 *
 * The table is bundled in the app for the 2026-10-07 launch; the follow-up moves the specs
 * into the catalog contract (DR-3). matrix-store-schedules.test.ts holds the two in step.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import yaml from 'js-yaml'

const SHELF = resolve(import.meta.dirname, '..', '..', '..', 'docs', 'shelf', 'agents')
const TARGET = resolve(import.meta.dirname, '..', 'shared', 'matrix-store-schedules.ts')
const BEGIN = '// BEGIN GENERATED SPECS (scripts/generate-matrix-store-schedules.mjs)'
const END = '// END GENERATED SPECS'

/** tools/blueprints.py parse_blueprint: the frontmatter's blueprint block, or null. */
export function shelfBlueprint(text) {
  const stripped = text.replace(/^\uFEFF/u, '').trimStart()

  if (!stripped.startsWith('---')) {
    return null
  }

  const after = stripped.slice(3)
  const end = after.indexOf('\n---')

  if (end === -1) {
    return null
  }

  const front = yaml.load(after.slice(0, end))
  const blueprint = front?.metadata?.hermes?.blueprint

  if (blueprint === undefined || blueprint === null) {
    return null
  }

  const schedule = String(blueprint.schedule ?? '').trim()

  if (typeof blueprint !== 'object' || !schedule) {
    throw new Error('invalid blueprint block')
  }

  return {
    name: String(front.name ?? '').trim(),
    schedule,
    deliver: String(blueprint.deliver ?? 'origin').trim() || 'origin',
    prompt: blueprint.prompt === undefined || blueprint.prompt === null ? null : String(blueprint.prompt)
  }
}

/**
 * The Store's item ID for a shelf listing, as docs/shelf/prepare-store-publication.py
 * `item_id` publishes it: `atum/agents/<slug>` is sold as `agent/<slug>`. Entitlements carry
 * this ID, never the listing's own, so the table is keyed by it.
 */
export function storeItemId(item) {
  const slug = typeof item?.id === 'string' && item.kind === 'agent' ? item.id.replace(/^atum\/agents\//, '') : ''

  if (!slug || slug === item.id || !/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`not an Atum agent listing: ${item?.id}`)
  }

  return `agent/${slug}`
}

export function shelfSchedules(root = SHELF) {
  const table = {}

  for (const agent of readdirSync(root).sort()) {
    const listing = JSON.parse(readFileSync(join(root, agent, 'listing.json'), 'utf8'))
    const specs = []

    for (const skill of readdirSync(join(root, agent, 'skills')).sort()) {
      let text

      try {
        text = readFileSync(join(root, agent, 'skills', skill, 'SKILL.md'), 'utf8')
      } catch {
        continue
      }

      const blueprint = shelfBlueprint(text)

      if (blueprint && blueprint.name.startsWith('atum-')) {
        specs.push({ id: blueprint.name.slice('atum-'.length), cron: blueprint.schedule, prompt: blueprint.prompt })
      }
    }

    if (specs.length) {
      table[storeItemId(listing.item)] = specs
    }
  }

  return table
}

function render(table) {
  const lines = [
    'export const MATRIX_STORE_SCHEDULES: Readonly<Record<string, readonly MatrixStoreScheduleSpec[]>> = {'
  ]

  for (const [item, specs] of Object.entries(table)) {
    lines.push(`  ${JSON.stringify(item)}: [`)

    for (const spec of specs) {
      lines.push(
        `    { id: ${JSON.stringify(spec.id)}, cron: ${JSON.stringify(spec.cron)}, prompt: ${JSON.stringify(spec.prompt)} },`
      )
    }

    lines.push('  ],')
  }

  lines.push('}')

  return lines.join('\n').replace(/,\n(\s*[\]}])/g, '\n$1')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const block = render(shelfSchedules())

  if (process.argv.includes('--write')) {
    const source = readFileSync(TARGET, 'utf8')
    const start = source.indexOf(BEGIN)
    const stop = source.indexOf(END)

    if (start === -1 || stop === -1) {
      throw new Error('generated block markers not found')
    }

    writeFileSync(TARGET, `${source.slice(0, start + BEGIN.length)}\n${block}\n${source.slice(stop)}`)
  } else {
    console.log(block)
  }
}
