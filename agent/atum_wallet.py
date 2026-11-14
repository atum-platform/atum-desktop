"""Cloud-key wallet hold, using native cron pause/resume and owner notices.

Only seeded cloud profiles opt in. A 402 never becomes a daily cron failure or
an untrusted provider error shown to the owner. The host's 0462 outbox owns the
single top-up notice. The supervisor's positive ledger/provider projection or a successful OpenRouter
request is refill proof; subscription success and an ambiguous owner-notice `none` cannot release a hold.
"""
from pathlib import Path
import logging
import os

logger = logging.getLogger(__name__)

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
    # Native updates serialize with the cron store. One damaged/terminal job
    # cannot prevent recovery of siblings or keep the durable hold latched.
    try:
        for job in jobs.load_jobs():
            try:
                if funded and job.get('paused_reason') == REASON:
                    jobs.resume_job(job['id'], skip_missed=True)
                elif not funded and job.get('enabled', True) and job.get('deliver') != 'local':
                    jobs.pause_job(job['id'], reason=REASON)
            except Exception:
                logger.warning('Wallet job transition failed; continuing recovery')
    finally:
        if funded:
            marker.unlink(missing_ok=True)


def managed_route(agent):
    route = os.environ.get('ATUM_MODEL_BASE_URL') or os.environ.get('ATUM_S2_MODEL_URL')
    return (bool(route) and str(getattr(agent, 'base_url', '')).rstrip('/') == route.rstrip('/')) or getattr(agent, 'provider', '') == 'openrouter'


def refused(agent, status):
    if status != 402 or not managed_route(agent) or not enabled():
        return False
    try:
        set_funded(False)
    except Exception:
        logger.warning("Wallet hold update failed")
    return True


def succeeded(agent):
    try:
        if (managed_route(agent) and getattr(agent, '_atum_wallet_held_at_request', False) and held()):
            set_funded(True)
    except Exception:
        logger.warning('Wallet recovery update failed')
