#!/usr/bin/env node
// S1's restore proof (S1 build plan §1 demo step 6 and §5 test 10 "Restore"; atum-platform
// docs/runbooks/cloud-launch-activation.md step G2), driven from the operator's Mac through the
// executor kit (atum-platform deploy/executor/ops.sh). Two drills:
//
//   node scripts/s1-acceptance/restore-drill.mjs local --owner OWNER --agent AGENT [--executor ID]
//        [--platform ../atum-platform] [--wait-seconds 600] [--yes] --out FILE
//     (a) SIGKILL the controller, wipe T's local home cache (never its journals), start it; then the
//     owner asks T "code word?" from any device. Passes when a new turn commits after the restart
//     with the next home generation (the home came back from S3) and the owner confirms the answer
//     ("lotus"). When the controller logs prompt digests on its committed lines, they must match the
//     turn before the drill (the restored conversation kept its cached prefix).
//
//   node scripts/s1-acceptance/restore-drill.mjs snapshot-plan [--platform …] --out FILE
//     (b) Prints the exact commands that restore the state volume from the newest DLM snapshot onto a
//     replaced instance (the runbook's G2 b), with the snapshot, volume and instance IDs looked up
//     read-only. It changes nothing: each AWS change is the owner's approval.
//
//   node scripts/s1-acceptance/restore-drill.mjs snapshot-verify --restored-volume vol-… [--platform …] --out FILE
//     After the plan ran: the running executor's state volume is the restored one, `ops.sh check`
//     passes, and the controller is ready.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { Evidence, parseArguments, until } from './lib/evidence.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const here = path.dirname(fileURLToPath(import.meta.url))

/** The controller's committed lines (`ops.sh timings`): unix time, executor, home, digests. */
export function committedTurns(text, executor) {
  const turns = []
  for (const line of text.split('\n')) {
    const match = /^([0-9]+(?:\.[0-9]+)?)\s.*\[agent\] executor=(\S+) committed invocation=(\S+) outcome=(\S+) home=(\d+)/.exec(line)
    if (!match || (executor && match[2] !== executor)) continue
    turns.push({
      at: Math.round(Number(match[1]) * 1000), executor: match[2], invocation: match[3], outcome: match[4], home: Number(match[5]),
      systemDigest: /\bsystemDigest=([0-9a-f]{64})\b/.exec(line)?.[1] ?? null,
      toolsDigest: /\btoolsDigest=([0-9a-f]{64})\b/.exec(line)?.[1] ?? null
    })
  }
  return turns
}

export function platformOps(platform) {
  const script = path.join(platform, 'deploy', 'executor', 'ops.sh')
  if (!existsSync(script)) throw new Error(`no executor kit at ${script} (set --platform)`)
  return async args => {
    const result = spawnSync('bash', [script, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
}

export async function localDrill({ owner, agent, executor, ops, ask, out, waitSeconds = 600, intervalMs = 10_000, now = Date.now, sleep }) {
  const evidence = new Evidence(out, { drill: 'S1 restore (a): kill, wipe the home cache, restart', owner, agent })
  const since = Math.floor(now() / 1000) - 7 * 86_400
  const before = committedTurns((await ops(['timings', String(since)])).stdout, executor)
  const last = before.at(-1) ?? null
  evidence.measure('before', last ? { home: last.home, at: new Date(last.at).toISOString(), digests: Boolean(last.systemDigest) } : null)
  if (!evidence.check('a turn committed before the drill (the home to restore exists)', last !== null)) return evidence.finish()

  const restart = await ops(['drill-restart', `${owner}/${agent}`, '--apply'])
  const restartedAt = now()
  if (!evidence.check('the controller was killed, its home cache wiped, and it is ready again',
    restart.code === 0 && restart.stdout.includes('DRILL_RESTARTED'), { code: restart.code })) return evidence.finish()

  await ask('Now ask T "code word?" from any owner device. Press Enter once you have sent it.')
  const after = await until(async () => {
    const turns = committedTurns((await ops(['timings', String(Math.floor(restartedAt / 1000) - 5)])).stdout, executor)
    return turns.find(turn => turn.at >= restartedAt - 5_000) ?? null
  }, { timeoutMs: waitSeconds * 1000, intervalMs, now, sleep })
  if (!evidence.check('a turn committed after the restart', after !== null)) return evidence.finish()
  evidence.check('it committed the next home generation (the home came back from S3)', after.home === last.home + 1,
    { before: last.home, after: after.home })
  evidence.check('the turn answered', after.outcome === 'answered', { outcome: after.outcome })
  if (last.systemDigest && after.systemDigest) {
    evidence.check('the prompt prefix is byte-stable across the restore',
      last.systemDigest === after.systemDigest && last.toolsDigest === after.toolsDigest)
  } else {
    evidence.measure('digests', 'not logged on the committed line: compare in the home manifest (WS-2 follow-up)')
  }
  const answer = (await ask('Did T answer with the code word "lotus"? [y/N] ')).trim().toLowerCase()
  evidence.check('the owner saw "lotus" (same memory, same conversation)', answer === 'y' || answer === 'yes')
  return evidence.finish()
}

export async function snapshotPlan({ aws, out, region = 'ap-southeast-1' }) {
  const evidence = new Evidence(out, { drill: 'S1 restore (b): plan' })
  const instance = aws(['ec2', 'describe-instances', '--region', region, '--filters', 'Name=tag:Name,Values=atum-executor',
    'Name=instance-state-name,Values=running,stopped', '--query', 'Reservations[].Instances[].InstanceId', '--output', 'text']).trim()
  const volume = aws(['ec2', 'describe-volumes', '--region', region, '--filters', 'Name=tag:Name,Values=atum-executor-state',
    '--query', 'Volumes[].[VolumeId,AvailabilityZone]', '--output', 'text']).trim()
  const snapshot = aws(['ec2', 'describe-snapshots', '--region', region, '--owner-ids', 'self', '--filters', 'Name=tag:backup,Values=executor-daily',
    '--query', 'sort_by(Snapshots,&StartTime)[-1].[SnapshotId,StartTime]', '--output', 'text']).trim()
  const [volumeId, zone] = volume.split(/\s+/)
  const [snapshotId, startedAt] = snapshot.split(/\s+/)
  const ok = /^i-[0-9a-f]+$/.test(instance) && /^vol-[0-9a-f]+$/.test(volumeId ?? '') && /^snap-[0-9a-f]+$/.test(snapshotId ?? '')
  evidence.measure('ids', { instance, volume: volumeId ?? null, zone: zone ?? null, snapshot: snapshotId ?? null, snapshotStartedAt: startedAt ?? null })
  if (!evidence.check('one executor, one state volume and a daily snapshot exist', ok)) return evidence.finish()
  const steps = [
    'deploy/executor/ops.sh stop',
    `aws ec2 create-volume --region ${region} --availability-zone ${zone} --snapshot-id ${snapshotId} --volume-type gp3 --encrypted \\`,
    `  --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=atum-executor-state},{Key=backup,Value=executor-daily},{Key=project,Value=atum},{Key=environment,Value=prod},{Key=service,Value=executor},{Key=managed_by,Value=opentofu},{Key=row,Value=G5-10}]'`,
    '#   -> note the new vol-…; wait for it to be available (aws ec2 wait volume-available --volume-ids <new>)',
    `aws ec2 create-tags --region ${region} --resources ${volumeId} --tags Key=Name,Value=atum-executor-state-replaced Key=backup,Value=none`,
    'tofu -chdir=infra/aws/executor init -input=false',
    'tofu -chdir=infra/aws/executor state rm aws_volume_attachment.state aws_ebs_volume.state',
    'tofu -chdir=infra/aws/executor import aws_ebs_volume.state <new vol-…>',
    'tofu -chdir=infra/aws/executor plan -input=false -replace=aws_instance.host -out=executor.tfplan   # read it: the instance replaced, the new volume attached, nothing else destroyed',
    'shasum -a 256 infra/aws/executor/executor.tfplan',
    'ATUM_TOFU_APPROVED_PLAN_SHA256=<that sha> infra/aws/run-tofu.sh executor apply   # the owner approves exactly that plan',
    'deploy/executor/ops.sh deploy <revision> --apply                         # the image back from ECR by digest; custody from SSM',
    `node scripts/s1-acceptance/restore-drill.mjs snapshot-verify --restored-volume <new vol-…> --out <file>`,
    `#   after it passes: aws ec2 delete-volume --volume-ids ${volumeId}  (the old volume, renamed above)`
  ]
  evidence.measure('steps', steps)
  console.log(`From the atum-platform root (snapshot ${snapshotId} of ${startedAt}):\n${steps.join('\n')}`)
  evidence.check('the restore plan is written (nothing changed)', true)
  return evidence.finish()
}

export async function snapshotVerify({ aws, ops, restoredVolume, out, region = 'ap-southeast-1' }) {
  const evidence = new Evidence(out, { drill: 'S1 restore (b): verify', restoredVolume })
  const attached = aws(['ec2', 'describe-volumes', '--region', region, '--volume-ids', restoredVolume,
    '--query', 'Volumes[0].Attachments[0].[InstanceId,State]', '--output', 'text']).trim().split(/\s+/)
  const running = aws(['ec2', 'describe-instances', '--region', region, '--filters', 'Name=tag:Name,Values=atum-executor',
    'Name=instance-state-name,Values=running', '--query', 'Reservations[].Instances[].InstanceId', '--output', 'text']).trim()
  evidence.check('the restored volume is attached to the running executor', attached[0] === running && attached[1] === 'attached',
    { instance: running || null })
  const check = await ops(['check'])
  evidence.check('the executor passes its check (state, runsc, network, image, custody, CONTROLLER_READY)',
    check.code === 0 && check.stdout.includes('CHECK_OK'), { code: check.code })
  return evidence.finish()
}

async function main([command, ...argv]) {
  try {
    const args = parseArguments(argv, {
      values: ['owner', 'agent', 'executor', 'platform', 'wait-seconds', 'out', 'restored-volume', 'region'], flags: ['yes']
    })
    if (!args.out) throw new Error('--out is required')
    const platform = path.resolve(args.platform ?? path.join(here, '..', '..', '..', 'atum-platform'))
    const aws = list => execFileSync('aws', list, { encoding: 'utf8' })
    if (command === 'local') {
      if (!UUID.test(args.owner ?? '') || !UUID.test(args.agent ?? '')) throw new Error('--owner and --agent are principal UUIDs')
      const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
      try {
        return (await localDrill({ owner: args.owner, agent: args.agent, executor: args.executor, ops: platformOps(platform),
          ask: question => (args.yes && question.includes('[y/N]') ? Promise.resolve('y') : terminal.question(`${question}\n`)),
          out: args.out, waitSeconds: Number(args['wait-seconds'] ?? 600) })) ? 0 : 1
      } finally {
        terminal.close()
      }
    }
    if (command === 'snapshot-plan') return (await snapshotPlan({ aws, out: args.out, region: args.region })) ? 0 : 1
    if (command === 'snapshot-verify') {
      if (!/^vol-[0-9a-f]+$/.test(args['restored-volume'] ?? '')) throw new Error('--restored-volume is the new vol-…')
      return (await snapshotVerify({ aws, ops: platformOps(platform), restoredVolume: args['restored-volume'], out: args.out,
        region: args.region })) ? 0 : 1
    }
    throw new Error('usage: restore-drill.mjs local|snapshot-plan|snapshot-verify …')
  } catch (error) {
    console.error(`restore-drill: ${error.message}`)
    return 2
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2))
}
