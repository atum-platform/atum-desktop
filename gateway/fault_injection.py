"""Disposable offline fault harness only; never enable in a deployed profile.

No prompt, tool schema, configuration or recovery algorithm is changed. An
exclusive marker outside the profile makes each fault fire once across boots.
"""
import errno
import os


def hit(point):
    if os.environ.get("ATUM_FAULT_TEST") != "1" or os.environ.get("ATUM_FAULT_POINT") != point:
        return
    if not os.environ.get("ATUM_FAULT_ONCE") or point == "H14":
        return
    fd = None
    try:
        fd = os.open(os.environ["ATUM_FAULT_ONCE"], os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.fsync(fd)
    except FileExistsError:
        return
    finally:
        if fd is not None:
            os.close(fd)
    if point in ("H7", "H12"):
        raise OSError(errno.ENOSPC, "injected persistence failure: " + point)
    if point == "H13":
        error = RuntimeError("injected expired Matrix cursor")
        error.errcode = "M_UNKNOWN_POS"
        raise error
    os._exit(86)


def warn_at_boot():
    if os.environ.get("ATUM_FAULT_TEST") == "1":
        import logging
        logging.getLogger(__name__).critical("FAULT INJECTION ENABLED (ATUM_FAULT_TEST=1). Disposable test profile only.")
