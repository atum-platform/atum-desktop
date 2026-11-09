"""Atum's thin RPC adapters over Hermes-native sessions and server requests."""

from __future__ import annotations

from .base import JsonValue, Params, Result
from .common import OpenModel, ProfileParams
from .registry import method


class RuntimeQuiesceParams(Params):
    timeout_ms: int = 60_000


class RuntimeQuiesceResult(Result):
    drained: bool
    pending: list[str]


method("runtime.quiesce", params=RuntimeQuiesceParams, result=RuntimeQuiesceResult,
       doc="Wait for post-turn background review before exporting the agent home.")


class HeartbeatEnsureParams(Params):
    force: bool = False


class HeartbeatEnsureResult(Result):
    job_id: str | None
    state: str


method("heartbeat.ensure", params=HeartbeatEnsureParams, result=HeartbeatEnsureResult,
       doc="Ensure the default assistant's sealed local check-in ticker exists.")


class CronRunClaimedParams(Params):
    job_id: str
    execution_id: str
    room_id: str
    sweep_gate: str | None = None


class CronRunClaimedResult(Result):
    job_id: str
    execution_id: str
    processed: bool
    status: str
    reason: str | None = None


method("cron.run_claimed", params=CronRunClaimedParams, result=CronRunClaimedResult,
       doc="Run one platform-claimed cloud occurrence through native Hermes cron execution.")
method("cron.run_claimed_desktop", params=CronRunClaimedParams, result=CronRunClaimedResult,
       doc="Run one private desktop occurrence through native Hermes cron execution.")


class ContextCapabilitiesParams(Params):
    session_id: str | None = None
    profile: str | None = None


class ContextCapabilitiesResult(Result):
    version: int
    backend_id: str
    agent_id: str
    submission_dedup: bool
    conversation_id: str | None = None


method("context.capabilities", params=ContextCapabilitiesParams, result=ContextCapabilitiesResult,
       doc="Stable backend/agent/conversation identity for a frozen desktop submission.")


class SubmissionStatusParams(Params):
    session_id: str
    submission_id: str


class SubmissionStatusResult(OpenModel):
    submission_id: str
    status: str


method("prompt.submission_status", params=SubmissionStatusParams, result=SubmissionStatusResult,
       doc="Read one durable managed-submission receipt without replaying it.")


class ManagedCancelParams(Params):
    session_id: str


class ManagedCancelResult(OpenModel):
    state: str | None = None


method("prompt.managed_cancel", params=ManagedCancelParams, result=ManagedCancelResult,
       doc="Cancel retained managed work after the live turn has stopped.")


class StoreRuntimeReconcileParams(Params):
    profile: str
    items: list[JsonValue]
    managedSkills: list[str]


class StoreRuntimeReconcileResult(OpenModel):
    profile: str
    outcome: str


method("store.runtime.reconcile", params=StoreRuntimeReconcileParams,
       result=StoreRuntimeReconcileResult,
       doc="Apply one controller-authored Store plan to a protected cloud home.")


class TrainingParams(Params):
    session_id: str
    task: dict[str, JsonValue] | None = None


class TrainingStatusResult(OpenModel):
    managed: bool
    can_bind: bool
    agent_id: str
    conversation_id: str
    task: dict[str, JsonValue] | None = None


class TrainingBindResult(OpenModel):
    task_id: str
    assistant_id: str
    assistant_identity_id: str
    conversation_id: str
    skill_id: str | None = None


method("training.status", params=TrainingParams, result=TrainingStatusResult,
       doc="Read the public training binding for one managed session.")
method("training.bind", params=TrainingParams, result=TrainingBindResult,
       doc="Bind public training metadata before the session's first prompt.")


class WordDocumentResolveParams(Params):
    request_id: str
    session_id: str
    turn_id: str


class WordDocumentResolveResult(OpenModel):
    turn_id: str
    session_id: str
    durable_session_id: str


method("word.document.resolve", params=WordDocumentResolveParams, result=WordDocumentResolveResult,
       doc="Resolve the native authority for one still-open Word server request.")


class PetExportBundleParams(ProfileParams):
    slug: str
    operationId: str


class PetBundleFile(Result):
    path: str
    content_base64: str


class PetBundle(Result):
    """``hermes_cli/atum_pet_bundles.py::export_pet_bundle``: canonical, portable pet files."""

    schema_version: int
    sha256: str
    files: list[PetBundleFile]


class PetExportBundleResult(Result):
    ok: bool
    bundle: PetBundle


method("pet.export_bundle", params=PetExportBundleParams, result=PetExportBundleResult,
       doc="Export a hatch operation's canonical pet files for the paid Store listing.")
