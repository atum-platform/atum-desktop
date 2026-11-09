#!/usr/bin/env node
// S1 acceptance test 4, lifecycle (S1 build plan §5; atum-platform docs/runbooks/cloud-launch-activation.md
// step G1), on the MacBook. After a sign-out, an account switch, a sleep or a network partition, Atum's
// device service must have stopped what T was doing on this Mac and must not run anything queued.
// The owner performs each action in Atum (or closes the lid, or turns the network off) at the moment
// the row names. This tool only reads the device audit log Atum keeps for its owner (WS-4
// device/audit.ts: JSONL of closed decisions and hashes) and records what it shows:
//
//   node scripts/s1-acceptance/lifecycle.mjs verify --since <ISO time just before the action> \
//     --moment long-command|approval|admission --action sign-out|account-switch|sleep|partition \
//     --out evidence/lifecycle-<moment>-<action>.json [--until <ISO time>] [--audit-dir DIR] \
//     [--chat-shows-stopped] [--processes-ended]
//
// Passes when, between --since and --until (default now): the Stop fence ran (a `stopped` decision) for
// a sign-out, account switch or sleep; nothing was admitted; and with the approval prompt open, nothing
// was approved. Two observations are the owner's: the chat shows the turn stopped or unconfirmed
// (--chat-shows-stopped), and Activity Monitor shows none of T's commands left running
// (--processes-ended). Exit 0 passed, 1 a check failed, 2 inconclusive (no audit log for the window).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Evidence, parseArguments } from './lib/evidence.mjs'

const MOMENTS = ['long-command', 'approval', 'admission']
const ACTIONS = ['sign-out', 'account-switch', 'sleep', 'partition']
export const DEFAULT_AUDIT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Atum', 'device', 'audit')

/** Audit entries in [since, until], from the day files that can hold them. Malformed lines are counted, not trusted. */
export function readAudit(dir, since, until) {
  if (!existsSync(dir)) return { entries: [], files: 0, malformed: 0 }
  const days = new Set()
  for (let day = new Date(new Date(since).toISOString().slice(0, 10)); day.getTime() <= until; day = new Date(day.getTime() + 86_400_000)) {
    days.add(`${day.toISOString().slice(0, 10)}.jsonl`)
  }
  const entries = []
  let files = 0
  let malformed = 0
  for (const name of readdirSync(dir).filter(file => days.has(file)).sort()) {
    files += 1
    for (const line of readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (Number.isFinite(entry.at) && typeof entry.decision === 'string') {
          if (entry.at >= since && entry.at <= until) entries.push(entry)
        } else malformed += 1
      } catch { malformed += 1 }
    }
  }
  return { entries: entries.sort((a, b) => a.at - b.at), files, malformed }
}

export function verifyLifecycle(options) {
  const evidence = new Evidence(options.out, { test: 'S1 acceptance 4: lifecycle', moment: options.moment, action: options.action })
  const since = Date.parse(options.since)
  const until = options.until ? Date.parse(options.until) : (options.now ?? Date.now())
  if (!Number.isFinite(since) || !Number.isFinite(until) || until < since) throw new Error('--since/--until must be ISO times, since before until')
  const audit = readAudit(options.auditDir ?? DEFAULT_AUDIT_DIR, since, until)
  evidence.measure('audit', { files: audit.files, entries: audit.entries.length, malformed: audit.malformed,
    decisions: audit.entries.reduce((counts, entry) => ({ ...counts, [entry.decision]: (counts[entry.decision] ?? 0) + 1 }), {}) })
  if (!audit.files) {
    evidence.check('the device audit log covers the window', false, { note: 'no audit file for these days: wrong --audit-dir, or the device service never ran' })
    evidence.finish({ verdict: 'inconclusive' })
    return 2
  }
  const decisions = new Set(audit.entries.map(entry => entry.decision))
  if (options.action !== 'partition') {
    const stopped = audit.entries.find(entry => entry.decision === 'stopped')
    evidence.check('the Stop fence ran', Boolean(stopped), stopped ? { afterMs: stopped.at - since } : { note: 'no `stopped` decision in the window' })
  }
  evidence.check('nothing was admitted after the action', !decisions.has('admitted'),
    { admitted: audit.entries.filter(entry => entry.decision === 'admitted').length })
  if (options.moment === 'approval') {
    evidence.check('the open approval was not used', !decisions.has('approved'),
      { approved: audit.entries.filter(entry => entry.decision === 'approved').length })
  }
  evidence.check('the chat shows the turn stopped or unconfirmed (owner)', Boolean(options.chatShowsStopped),
    options.chatShowsStopped ? {} : { note: 'confirm in Atum, then rerun with --chat-shows-stopped' })
  evidence.check('none of T\'s commands are left running (owner, Activity Monitor)', Boolean(options.processesEnded),
    options.processesEnded ? {} : { note: 'confirm, then rerun with --processes-ended' })
  return evidence.finish({ verdict: 'checked' }) ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [mode, ...rest] = process.argv.slice(2)
  try {
    if (mode !== 'verify') throw new Error('usage: lifecycle.mjs verify --since ISO --moment M --action A --out FILE')
    const args = parseArguments(rest, { values: ['since', 'until', 'moment', 'action', 'out', 'audit-dir'], flags: ['chat-shows-stopped', 'processes-ended'] })
    if (!MOMENTS.includes(args.moment) || !ACTIONS.includes(args.action) || !args.since || !args.out) {
      throw new Error(`--moment one of ${MOMENTS.join('|')}, --action one of ${ACTIONS.join('|')}, --since and --out are required`)
    }
    process.exitCode = verifyLifecycle({ since: args.since, until: args.until, moment: args.moment, action: args.action, out: args.out,
      auditDir: args['audit-dir'], chatShowsStopped: args['chat-shows-stopped'], processesEnded: args['processes-ended'] })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
}
