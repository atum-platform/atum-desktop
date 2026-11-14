"""Atomic desktop custody handoff, using Hermes's native auth transaction.

Only synthetic tests call this directly. Desktop main invokes the CLI over pipes;
stdout is private IPC and must never be logged. Ambiguous imports stay paused.
"""
import json
import sys
from pathlib import Path


def transition(home, action):
    from hermes_cli.auth import _auth_store_lock, _load_auth_store, _save_auth_store
    target = Path(home) / 'auth.json'
    with _auth_store_lock(target_path=target):
        store = _load_auth_store(target)
        carry = store.get('chatgpt_carry', {})
        state = carry.get('state', 'local')
        if action == 'begin':
            if state == 'carried':
                return {'state': state}
            if state == 'local':
                provider = store.get('providers', {}).get('openai-codex')
                rows = store.get('credential_pool', {}).get('openai-codex', [])
                pairs = [r for r in rows if r.get('refresh_token') and r.get('access_token')]
                if provider and provider.get('tokens', {}).get('refresh_token'):
                    pairs.append(provider['tokens'])
                chains = {r['refresh_token'] for r in pairs}
                if len(chains) != 1:
                    return {'state': 'unavailable'}  # Never guess between independent grants.
                carry = {'state': 'paused', 'provider': provider, 'rows': rows,
                         'tokens': {k: pairs[0][k] for k in ('access_token', 'refresh_token')}}
                store.setdefault('providers', {}).pop('openai-codex', None)
                store.setdefault('credential_pool', {}).pop('openai-codex', None)
                store['chatgpt_carry'] = carry
                _save_auth_store(store, target_path=target)
            return {'state': 'paused', **carry['tokens']}
        if action == 'rollback':
            if state != 'paused':
                return {'state': state}
            # A new interactive login must never be overwritten by recovery.
            if store.get('providers', {}).get('openai-codex') or store.get('credential_pool', {}).get('openai-codex'):
                raise ValueError('carry_conflict')
            if carry.get('provider'):
                store.setdefault('providers', {})['openai-codex'] = carry['provider']
            store.setdefault('credential_pool', {})['openai-codex'] = carry['rows']
            store.pop('chatgpt_carry', None)
            _save_auth_store(store, target_path=target, _carry_recovery=True)
            return {'state': 'local'}
        if action == 'commit':
            store.setdefault('providers', {}).pop('openai-codex', None)
            store.setdefault('credential_pool', {}).pop('openai-codex', None)
            store['chatgpt_carry'] = {'state': 'carried'}
            _save_auth_store(store, target_path=target)
            return {'state': 'carried'}
        raise ValueError('carry_action_invalid')


def _main():
    try:
        value = json.loads(sys.stdin.buffer.read(4096))
        result = transition(value['home'], value['action'])
        sys.stdout.write(json.dumps(result))
        return 0
    except Exception:
        return 1  # Never print exception text, credentials or native provider errors.


if __name__ == '__main__':
    raise SystemExit(_main())
