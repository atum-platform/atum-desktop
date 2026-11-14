"""Authenticated same-user source Stop over the existing gateway control socket."""
import asyncio
from pathlib import Path


async def _cancel_native_source(authority, room, event, sender):
    """Cancel only this source, or interrupt its exact native claimed generation."""
    from gateway.config import Platform
    from gateway.session_contract import Principal, SessionRef
    from gateway.session_envelope import restore_native_source
    from hermes_state_runtime import RuntimeStoreError, get_session_admission
    candidates = await asyncio.to_thread(authority.db._read_all,
        "SELECT admission_id FROM session_admissions WHERE request_id=? AND principal_id LIKE 'messaging:%'", (event,))
    actor = Principal('messaging-control', authority.profile_id,
                      frozenset({'session:submit', 'session:control'}), 'source-stop')
    for candidate in candidates:
        row = await asyncio.to_thread(get_session_admission, authority.db, admission_id=candidate['admission_id'])
        if row is None or 'native_text_v1' not in row['payload']:
            continue
        origin = restore_native_source(row['payload'], authority.runner)
        if origin.platform != Platform.MATRIX or (origin.chat_id, origin.user_id) != (room, sender):
            continue
        ref = SessionRef(authority.profile_id, row['target_session_id'])
        try:
            if row['status'] == 'queued':
                row = await authority.cancel_or_claimed(actor, ref, row['admission_id'])
                if row is None:
                    continue
            if row['status'] == 'started':
                await authority.interrupt(actor, ref, row['generation'])
        except RuntimeStoreError as exc:
            if exc.reason != 'stale_generation':
                raise
            # Settled while stopping: never redirect an old Stop to its successor.


def register_source_stop(server, runner, loop):
    """Register a private verb. GatewayControlServer authenticates the local peer."""
    async def stop(params):
        from gateway.config import Platform
        from gateway.session_authorities import owner_scope, require_serving
        if (set(params) != {'profile_id', 'room', 'event', 'sender', 'action'}
                or any(not isinstance(v, str) or not v or len(v) > 2048 for v in params.values())
                or params['action'] not in {'stop', 'receipt'}):
            raise ValueError('invalid source Stop parameters')
        home = Path(params['profile_id'])
        if not home.is_absolute() or home != home.resolve():
            raise ValueError('canonical served profile required')
        registry = getattr(runner, 'session_authorities', None)
        authority = registry.for_home(home) if registry is not None else None
        if authority is None:
            raise ValueError('profile unavailable')
        require_serving(authority)
        name = registry.profile_name(authority)
        adapters = runner.adapters if name is None else getattr(runner, '_profile_adapters', {}).get(name, {})
        adapter = adapters.get(Platform.MATRIX)
        rejected = {'accepted': False, 'receipt': None}
        if adapter is None:
            return rejected
        room, event, sender = (params[k] for k in ('room', 'event', 'sender'))
        with owner_scope(authority):
            if not adapter._is_authorized_user(sender, room):
                return rejected
            box = getattr(adapter, '_presentation_box', None)
            if box is None:
                return rejected
            if params['action'] == 'stop':
                if not await adapter.stop_presentation_turn(room, event, sender, authenticated=True):
                    return rejected
            if not box.cancelled(room, event, sender):
                return rejected
            # A receipt retry also completes cancellation after an earlier ambiguous
            # control response. The existing durable tuple covers pre-admission work.
            await _cancel_native_source(authority, room, event, sender)
        return {'accepted': True, 'receipt': dict(room=room, event=event, sender=sender)}

    def handler(params, peer_subject):
        if not peer_subject:
            raise PermissionError('authenticated local peer required')
        return asyncio.run_coroutine_threadsafe(stop(params), loop).result(timeout=5)

    server.private_handlers['stop-source'] = handler
