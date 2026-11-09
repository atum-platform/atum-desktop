/** Node parser -> JSON bytes -> real Python gateway validator. No private source. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseExecutionTask } from '../apps/desktop/shared/atum-hiring.ts';
const root = fileURLToPath(new URL('..', import.meta.url));
for (const skill of [null, 'cloud/briefing']) {
  const publicTask = parseExecutionTask({ task_id: '13100000-0000-4000-8000-000000000001',
    assistant_id: '13100000-0000-4000-8000-000000000002', assistant_identity_id: '13100000-0000-4000-8000-000000000003',
    conversation_id: 'seam-conversation', skill_id: skill, instructions: 'PRIVATE_SOURCE_MARKER' });
  const bytes = JSON.stringify(publicTask);
  assert.ok(!bytes.includes('PRIVATE'));
  const python = spawnSync(process.env.PYTHON ?? `${root}/.venv/bin/python`, ['-c',
    'import json,sys; from hermes_cli.atum_training import validate_task; print(json.dumps(validate_task(json.load(sys.stdin))))'],
    { cwd: root, input: bytes, encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(JSON.parse(python.stdout), publicTask);
}
console.log('PASS ordinary employee and selected-skill task descriptors cross the real Node/Python seam');
