"""Environment boundary shared by retained Store and network consumers."""
import os


def in_cloud_sandbox(environ: dict | None = None) -> bool:
    """Whether this Hermes runs in an Atum cloud task sandbox: only the controller sets the task's
    workspace and deadline (atum.cloud-execution/1 ``sandbox.environment``)."""
    env = os.environ if environ is None else environ
    return bool(env.get("ATUM_TASK_WORKSPACE")) and bool(env.get("ATUM_TASK_DEADLINE_MS"))

