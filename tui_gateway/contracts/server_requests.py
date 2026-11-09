"""Server→client requests: the backend asks the renderer a question (``server_requests.send``).

Every entry is one request method: the ``params`` the frame carries (``session_id`` is added by
the transport and declared on the shared base) and the ``result`` the client answers with. The
``request.cancel`` event that withdraws an open request lives here too.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from tools.tour_presets import TourPreset

from .base import JsonValue, Params, Payload, Result, WireEnum
from .registry import event, server_request


class ServerRequestParams(Params):
    """Every request frame's params start with the session the question belongs to."""

    session_id: str


class ValueResult(Result):
    """The answer to any one-string prompt (sudo, secret, vault prompts, desktop bridges):
    ``''`` means skipped / declined."""

    value: str


# ── clarify ───────────────────────────────────────────────────────────────────────────────────


class ClarifyQuestion(Params):
    qid: str
    question: str
    choices: list[str] | None = None
    multi_select: bool = False


class ClarifyRequestParams(ServerRequestParams):
    """``answers`` rides only on a reconnect replay (locks the server already accepted; null = skipped)."""

    questions: list[ClarifyQuestion]
    answers: dict[str, str | None] | None = None


class ClarifyResult(Result):
    """``{answers}`` for the whole set (early locks go through the ``clarify.lock`` RPC); a response
    without ``answers`` is cancel-all. ``outcome`` (optional): how the viewer's own panel ended, as
    main's classic CLI reports it (``timed_out`` keeps the answers locked before its deadline)."""

    answers: dict[str, str | None] | None = None
    outcome: Literal["submitted", "timed_out", "cancelled"] | None = None


server_request("clarify", params=ClarifyRequestParams, result=ClarifyResult,
               doc="The clarify tool: ask the user 1-5 questions.")



# ── setup_beat (first-run onboarding) ─────────────────────────────────────────────────────────


class SetupBeat(WireEnum):
    name = "name"
    theme = "theme"
    layout = "layout"
    connectors = "connectors"
    plugins = "plugins"
    tour = "tour"
    build = "build"


class SetupOption(Params):
    id: str
    label: str


class SetupNameCard(Params):
    suggested: str | None = None  # the OS account's name: shown on the card, never sent to the model


class SetupThemeCard(Params):
    picker: str


class SetupOptionsCard(Params):
    options: list[SetupOption]


class SetupConnectorsCard(Params):
    suggested: list[str]


class SetupPluginsCard(Params):
    plugins: list[str]


class SetupBeatRequestParams(ServerRequestParams):
    """``card`` is the beat's data (``agent/onboarding_flow.py::BEATS``): name, theme, connectors and
    plugins have their own shape; layout, tour and build carry ``options``. ``tool_call_id`` is the
    setup_beat call the card belongs to: only that transcript row draws it."""

    beat: SetupBeat
    question: str | None = None
    tool_call_id: str | None = None
    card: SetupNameCard | SetupThemeCard | SetupOptionsCard | SetupConnectorsCard | SetupPluginsCard


class SetupNameAnswer(Result):
    name: str


class SetupThemeAnswer(Result):
    accent: str | None = None
    mode: str | None = None


class SetupLayoutAnswer(Result):
    layout: str


class SetupConnectorsAnswer(Result):
    connected: list[str]
    newly_connected: list[str] = Field(default_factory=list)


class SetupPluginsAnswer(Result):
    installed: list[str]
    label: str | None = None  # what the card showed, for the transcript; never recorded


class SetupTourAnswer(Result):
    tour: str
    label: str | None = None


class SetupBuildAnswer(Result):
    build: str
    label: str | None = None


class SetupBeatResult(Result):
    """``answer`` holds the shown beat's picks; ids must be one of the card's options (the backend
    rejects any other answer). ``said`` is composer text typed while the name card waited: the name.
    ``wrote_instead``: the user sent a message instead of answering; the backend ends the turn and the
    client sends that message as the next one. A response with none of these, or none within 300 s,
    closes the card unanswered."""

    answer: (SetupNameAnswer | SetupThemeAnswer | SetupLayoutAnswer | SetupConnectorsAnswer | SetupPluginsAnswer
             | SetupTourAnswer | SetupBuildAnswer | None) = None
    said: str | None = None
    wrote_instead: bool = False


server_request("setup_beat", params=SetupBeatRequestParams, result=SetupBeatResult,
               doc="The onboarding chat's card for one beat; blocks setup_beat until answered (300 s).")


# ── approval ──────────────────────────────────────────────────────────────────────────────────


class ApprovalChoice(WireEnum):
    once = "once"
    session = "session"
    always = "always"
    deny = "deny"


class ApprovalRequestParams(ServerRequestParams):
    """``tui_gateway/server.py::_approval_request_payload`` — the command is redacted server-side."""

    request_id: str
    command: str = ""
    description: str = ""
    choices: list[ApprovalChoice] = Field(default_factory=list)
    allow_permanent: bool | None = None
    allow_session: bool | None = None
    smart_denied: bool | None = None
    tool_name: str | None = None
    session_id_hint: str | None = Field(default=None, alias="gateway_session_id")
    # The approval queue entry carries tool-specific context the card may render; the closed set
    # of keys is owned by tools/approval.py, so it stays open here.
    model_config = Params.model_config | {"extra": "allow"}


class ApprovalResult(Result):
    choice: ApprovalChoice
    all: bool | None = None


server_request("approval", params=ApprovalRequestParams, result=ApprovalResult,
               doc="A dangerous command awaits the user's decision.")


# ── one-string prompts ────────────────────────────────────────────────────────────────────────


class EmptyRequestParams(ServerRequestParams):
    pass


class SudoRequestParams(ServerRequestParams):
    """Original command, redacted server-side before any password-injection rewrite."""

    command: str = ""


server_request("sudo", params=SudoRequestParams, result=ValueResult,
               doc="Masked sudo password for the terminal tool.")


class SecretRequestParams(ServerRequestParams):
    env_var: str
    prompt: str
    metadata: dict[str, JsonValue] | None = None


server_request("secret", params=SecretRequestParams, result=ValueResult,
               doc="Masked value for a named env var (skills / setup flows).")


class VaultUnlockRequestParams(ServerRequestParams):
    backend: str
    display_name: str


server_request("vault.unlock_prompt", params=VaultUnlockRequestParams, result=ValueResult,
               doc="Master password to unlock an external password manager for this session.")


class VaultSaveLoginRequestParams(ServerRequestParams):
    origin: str
    site: str


server_request("vault.save_login", params=VaultSaveLoginRequestParams, result=ValueResult,
               doc="Save a login for a site the agent is about to fill; the answer is JSON {identifier, password}.")


class VaultCodeRequestParams(ServerRequestParams):
    site: str | None = None
    hint: str | None = None


server_request("vault.code", params=VaultCodeRequestParams, result=ValueResult,
               doc="A one-time / 2FA code the user reads from their device.")


# ── desktop GUI bridges ───────────────────────────────────────────────────────────────────────


class ReadRangeRequestParams(ServerRequestParams):
    start: int | None = None
    count: int | None = None


server_request("terminal.read", params=ReadRangeRequestParams, result=ValueResult,
               doc="Read the visible in-app terminal buffer (JSON text answer).")
server_request("preview.read", params=ReadRangeRequestParams, result=ValueResult,
               doc="Read the in-app browser preview's text (JSON text answer).")
server_request("window.read", params=EmptyRequestParams, result=ValueResult,
               doc="Enumerate the native window below the app (JSON text answer).")


class PreviewActRequestParams(ServerRequestParams):
    """``tools/drive_preview_tool.py`` and ``tools/annotate_preview_tool.py`` field sets."""

    action: str
    ref: str | None = None
    selector: str | None = None
    text: str | None = None
    key: str | None = None
    submit: bool | None = None
    full: bool | None = None
    to: str | None = None
    amount: int | None = None
    max: int | None = None
    allow_shortcut: bool | None = None


server_request("preview.act", params=PreviewActRequestParams, result=ValueResult,
               doc="Click / type / scroll / annotate inside the in-app browser preview.")


class TourStep(Params):
    selector: str | None = None
    title: str | None = None
    text: str | None = None
    side: str | None = None
    model_config = Params.model_config | {"extra": "allow"}


class TourRequestParams(ServerRequestParams):
    """``tools/tour_tool.py`` field set."""

    action: str
    surface: str | None = None
    selector: str | None = None
    title: str | None = None
    text: str | None = None
    side: str | None = None
    steps: list[TourStep] | None = None
    step_index: int | None = None
    preset: TourPreset | None = None


server_request("tour", params=TourRequestParams, result=ValueResult,
               doc="Drive a guided tour highlight in the desktop renderer.")


class ThemeMode(WireEnum):
    light = "light"
    dark = "dark"
    system = "system"


class ThemePicker(WireEnum):
    accent = "accent"
    layout = "layout"


class ThemeApplyRequestParams(ServerRequestParams):
    """``tools/set_theme_tool.py`` values; accent is a swatch id, ``theme`` or ``#rrggbb``."""

    accent: str | None = None
    mode: ThemeMode | None = None
    layout: str | None = None


class ThemePickRequestParams(ServerRequestParams):
    picker: ThemePicker


class ThemeValues(Params):
    """What the renderer applied. ``accent`` is a swatch id, ``custom:#rrggbb``, or null for the theme's own."""

    accent: str | None = None
    mode: ThemeMode | None = None
    layout: str | None = None


class ThemePickResult(Result):
    """``picked`` once the user chose (already applied); ``cancelled`` when the card was dismissed. A response
    with neither is a cancel."""

    picked: ThemeValues | None = None
    said: str | None = None
    cancelled: bool | None = None


server_request("theme.apply", params=ThemeApplyRequestParams, result=ValueResult,
               doc="Apply set_theme values in the window showing the session (JSON text answer).")
server_request("theme.pick", params=ThemePickRequestParams, result=ThemePickResult,
               doc="Show an accent or layout picker card in the chat and wait for the pick.")


# ── Atum host adapters ───────────────────────────────────────────────────────
# Runtime authority stamps ``turn_id`` (and expiry where applicable). Model
# tool arguments can select only the closed operation fields below.


class AtumTurnRequestParams(ServerRequestParams):
    turn_id: str


class AtumAppsListRequestParams(AtumTurnRequestParams):
    pass


class AtumAppsOpenRequestParams(AtumTurnRequestParams):
    app_id: str


server_request("atum.apps.list", params=AtumAppsListRequestParams, result=ValueResult,
               doc="Read the account-authorized Atum app catalog (JSON text answer).")
server_request("atum.apps.open", params=AtumAppsOpenRequestParams, result=ValueResult,
               doc="Open one account-authorized Atum app (JSON text answer).")


class AtumStoreRequestParams(AtumTurnRequestParams):
    operation: str
    query: str = ""
    limit: int = 10
    kind: str | None = None
    itemId: str | None = None


server_request("atum.store", params=AtumStoreRequestParams, result=ValueResult,
               doc="Read-only Store discovery and item inspection (JSON text answer).")


class AtumAgentsRequestParams(AtumTurnRequestParams):
    operation: str
    target: str | None = None
    expectedDefinitionRevision: int | None = None
    expectedIdentityRevision: int | None = None
    displayName: str | None = None
    soul: str | None = None
    avatar: dict[str, str] | None = None


server_request("atum.agents", params=AtumAgentsRequestParams, result=ValueResult,
               doc="Identity-bound Atum agent profile management (JSON text answer).")


class AtumAgentTasksRequestParams(AtumTurnRequestParams):
    operation: str
    target: str | None = None
    taskId: str | None = None
    prompt: str | None = None
    text: str | None = None
    timeoutMinutes: int | None = None


server_request("atum.agent_tasks", params=AtumAgentTasksRequestParams, result=ValueResult,
               doc="Persistent agent task hand-offs and control (JSON text answer).")


class AtumRoutinesRequestParams(AtumTurnRequestParams):
    profile: str
    operation: str
    routineId: str | None = None
    expectedRevision: int | None = None
    title: str | None = None
    instruction: str | None = None
    schedule: dict[str, JsonValue] | None = None
    timezone: str | None = None
    enabled: bool | None = None
    notifications: bool | None = None


server_request("atum.routines", params=AtumRoutinesRequestParams, result=ValueResult,
               doc="The managed account's routine projection (JSON text answer).")


class AtumChatsRequestParams(AtumTurnRequestParams):
    op: str
    unreadOnly: bool | None = None
    sinceMs: int | None = None
    limit: int | None = None
    id: str | None = None
    before: str | None = None
    query: str | None = None


server_request("atum.chats", params=AtumChatsRequestParams, result=ValueResult,
               doc="Bounded read-only Atum chat access (JSON text answer).")


class AtumMacRequestParams(AtumTurnRequestParams):
    op: str
    days: int | None = None
    limit: int | None = None
    id: str | None = None
    browser: str | None = None
    mode: str | None = None
    precision: str | None = None


server_request("atum.mac", params=AtumMacRequestParams, result=ValueResult,
               doc="Read one consented source on the owner's live Mac (JSON text answer).")


class AtumWorkspaceFetchRequestParams(AtumTurnRequestParams):
    path: str
    destination: str | None = None


server_request("atum.workspace.fetch", params=AtumWorkspaceFetchRequestParams, result=ValueResult,
               doc="Fetch one validated workspace-relative file through the owning host.")


class AtumAdvisorySearchRequestParams(AtumTurnRequestParams):
    query: str = ""
    reference: str | None = None
    limit: int = 3


server_request("atum.advisory.search", params=AtumAdvisorySearchRequestParams, result=ValueResult,
               doc="One bounded read of the active advisor's admitted discussion history.")


class AtumAwarenessRetrieveRequestParams(AtumTurnRequestParams):
    request: dict[str, JsonValue]


server_request("atum.awareness.retrieve", params=AtumAwarenessRetrieveRequestParams, result=ValueResult,
               doc="Retrieve one authority-bound, cited awareness result for the active run.")


class AtumDeviceRequestParams(AtumTurnRequestParams):
    tool: str
    device: str | None = None
    args: dict[str, JsonValue] = Field(default_factory=dict)
    tool_call_id: str = ""
    needs: list[str] | None = None
    expires_at: int


server_request("atum.device", params=AtumDeviceRequestParams, result=ValueResult,
               doc="Route one admitted tool call to the controller's device host.")


class WordDocumentRequestParams(AtumTurnRequestParams):
    action: str
    revision: str = ""
    find: str = ""
    replacement: str = ""
    expires_at: float


server_request("word.document", params=WordDocumentRequestParams, result=ValueResult,
               doc="Read or replace text in the live turn's paired Word document.")


class CronDeliveryRequestParams(ServerRequestParams):
    platform: str
    room_id: str
    text: str
    job_id: str
    execution_id: str


server_request("cron.delivery.request", params=CronDeliveryRequestParams, result=ValueResult,
               doc="Ask the connected host app to post one cron occurrence.")


class HeartbeatHostRequestParams(ServerRequestParams):
    job_id: str


server_request("heartbeat.gate.request", params=HeartbeatHostRequestParams, result=ValueResult,
               doc="Ask the connected owner app whether one local check-in occurrence is due.")
server_request("heartbeat.off.request", params=HeartbeatHostRequestParams, result=ValueResult,
               doc="Ask the connected owner app to turn check-ins off for the account.")


# ── withdrawal ────────────────────────────────────────────────────────────────────────────────


class RequestCancelReason(WireEnum):
    timeout = "timeout"
    interrupted = "interrupted"
    shutdown = "shutdown"
    resolved = "resolved"
    session_closed = "session_closed"


class RequestCancelPayload(Payload):
    id: str
    method: str
    reason: str  # a RequestCancelReason value; callers in tools/approval may pass their own wording


event("request.cancel", RequestCancelPayload,
      doc="The backend withdrew an open server→client request; clear the matching card only.")
