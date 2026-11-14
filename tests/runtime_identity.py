"""Identity fields for synthetic records that represent a current host owner.

Use the production witness so fixtures model both Linux/container identity and
hosts without a readable epoch. Foreign/legacy identity tests supply their own.
"""


def current_owner_fields(pid=None):
    import os
    from gateway.status import get_process_epoch, get_process_start_time

    return {"boot_epoch": get_process_epoch(),
            "start_time": get_process_start_time(os.getpid() if pid is None else pid)}
