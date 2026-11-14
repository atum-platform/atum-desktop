"""Exact cron-source Stop receipts; cancellation stays with the native cron owner."""
import asyncio
import hashlib
import json
from pathlib import Path


async def stop_schedule(authority, params):
    from gateway.session_cron import operation
    from hermes_state_keys import CRON_PRINCIPAL_ID, cron_request_id
    from hermes_state_runtime import get_session_admission
    from utils import atomic_json_write

    job, execution = params['job'], params['execution']
    identity = dict(kind='schedule', job=job, execution=execution)
    # member is an opaque annotation: never part of lookup, authorization or cancellation.
    if 'member' in params:
        identity['member'] = params['member']
    key = hashlib.sha256(json.dumps([job, execution]).encode()).hexdigest()
    path = Path(authority.profile_id) / 'cron' / 'stop-receipts' / (key + '.json')
    unknown = {'accepted': False, 'state': 'unknown', 'receipt': None}
    saved = json.loads(await asyncio.to_thread(path.read_text)) if path.exists() else None
    if saved is not None:
        if (saved['job'], saved['execution']) != (job, execution):
            raise ValueError('schedule Stop identity conflict')
        identity = {k: v for k, v in saved.items() if k != 'state'}
        if saved['state'] in {'finished', 'interrupted'}:
            return dict(accepted=True, state=saved['state'], receipt=saved)
    elif params['action'] == 'receipt':
        return unknown

    async def save(state):
        receipt = dict(identity, state=state)
        await asyncio.to_thread(path.parent.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(atomic_json_write, path, receipt, mode=0o600, fsync_dir=True)
        return receipt

    rows = await asyncio.to_thread(authority.db._read_all,
        'SELECT admission_id FROM session_admissions WHERE principal_id=? AND request_id=?',
        (CRON_PRINCIPAL_ID, cron_request_id(job, execution)))
    row = (await asyncio.to_thread(get_session_admission, authority.db,
                                  admission_id=rows[0]['admission_id'])) if rows else None
    if row is None:
        from cron.executions import get_execution
        record = await asyncio.to_thread(get_execution, execution)
        if record is None or record['job_id'] != job or record['status'] not in {'completed', 'failed'}:
            return unknown
        state = 'finished'
    elif row['status'] == 'unknown':
        return unknown
    else:
        if row['status'] != 'terminal':
            # Persist the intent before cancellation. A receipt retry completes an ambiguous Stop,
            # including the claim-before-execute window handled by operation('cancel').
            await save('pending')
            await operation(authority, 'cancel', dict(session_id=row['target_session_id'],
                                                     admission_id=row['admission_id']))
            deadline = asyncio.get_running_loop().time() + 3.0
            while row['status'] in {'queued', 'started'}:
                if asyncio.get_running_loop().time() >= deadline:
                    return dict(accepted=False, state='pending', receipt=None)
                await asyncio.sleep(.025)
                row = await asyncio.to_thread(get_session_admission, authority.db,
                                               admission_id=row['admission_id'])
            if row['status'] != 'terminal':
                return unknown
        state = 'interrupted' if row.get('outcome') in {'cancelled', 'interrupted'} else 'finished'
    receipt = await save(state)
    return dict(accepted=True, state=state, receipt=receipt)
