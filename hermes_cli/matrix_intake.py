"""Offline Matrix journal inspection and explicit reconciliation, never cursor reset."""
import json
import sqlite3
import time
from pathlib import Path


def cmd_matrix_intake(args):
    path = Path(args.store).resolve(strict=True)
    # Inspection must work without opening a homeserver, and must not create/migrate a DB.
    conn = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    try:
        if conn.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise RuntimeError('corrupt Matrix intake store: restore a verified backup; do not delete it')
        if args.action == 'status':
            state = {k: json.loads(v) for k, v in conn.execute('SELECT * FROM sync_state')}
            state.pop('pending', None)  # do not dump private message bodies
            print(json.dumps({'state': state,
                'receipts': list(conn.execute('SELECT state,count(*) FROM intake_events GROUP BY state')),
                'pending_batch': conn.execute("SELECT value != 'null' FROM sync_state WHERE key='pending'").fetchone(),
                'encrypted': list(conn.execute('SELECT event_id,room,attempts,created FROM encrypted_pending'))}, indent=2))
            return
        if not args.reconciled or not args.event:
            raise ValueError('Stop the gateway and reconcile external effects first; supply --event and --reconciled reason')
        backup_path = str(path) + f'.backup-{time.time_ns()}'
        with sqlite3.connect(backup_path) as backup:
            conn.backup(backup)
        Path(backup_path).chmod(0o600)
    finally:
        conn.close()
    from plugins.platforms.matrix.intake import MatrixIntakeStore
    store = MatrixIntakeStore(path)
    try:
        if args.action == 'retry':
            with store.db:
                store.db.execute('UPDATE encrypted_pending SET attempts=0,notified=0,created=? WHERE event_id=?',
                                 (time.time(), args.event))
        else:
            if store.state(args.event) != 'ambiguous':
                raise ValueError('Only an ambiguous control can be reconciled as done')
            store.mark(args.event, 'done', args.reconciled)
        print(f'Reconciled {args.event}; original preserved at {backup_path}; cursor unchanged')
    finally:
        store.close()
