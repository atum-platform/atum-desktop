"""Cloud-key wallet hold, using native cron pause/resume and owner notices.

Only seeded cloud profiles opt in. A 402 never becomes a daily cron failure or
an untrusted provider error shown to the owner. The host's 0462 outbox owns the
single top-up notice. The supervisor's positive ledger/provider projection or a successful OpenRouter
request is refill proof; subscription success and an ambiguous owner-notice `none` cannot release a hold.
"""
from pathlib import Path

REASON = 'atum-wallet-empty'


def enabled():
    from hermes_cli.config import load_config_readonly
    return (load_config_readonly() or {}).get('atum_cloud', {}).get('model_key') is True


def held():
    from hermes_constants import get_hermes_home
    return enabled() and (Path(get_hermes_home()) / 'cron' / REASON).exists()


def set_funded(funded):
    from cron import jobs
    from hermes_constants import get_hermes_home
    if not enabled():
        return
    marker = Path(get_hermes_home()) / 'cron' / REASON
    marker.parent.mkdir(parents=True, exist_ok=True)
    if not funded:
        marker.touch(mode=0o600, exist_ok=True)
    elif not marker.exists():
        return
    # Native updates serialize with the cron store. Never resume owner-paused jobs.
    for job in jobs.load_jobs():
        if funded:
            if job.get('paused_reason') == REASON:
                try:
                    jobs.resume_job(job['id'], skip_missed=True)
                except ValueError:
                    # Expired one-shots require explicit native rearming. They
                    # stay paused; never replay them or block recurring recovery.
                    if job['schedule'].get('kind') != 'once':
                        raise
        elif job.get('enabled', True) and job.get('deliver') != 'local':
            jobs.pause_job(job['id'], reason=REASON)
    if funded:
        marker.unlink(missing_ok=True)


def refused(agent, status):
    if status != 402 or getattr(agent, 'provider', '') != 'openrouter' or not enabled():
        return False
    set_funded(False)
    return True


def succeeded(agent):
    if (getattr(agent, 'provider', '') == 'openrouter'
            and getattr(agent, '_atum_wallet_held_at_request', False) and held()):
        set_funded(True)
