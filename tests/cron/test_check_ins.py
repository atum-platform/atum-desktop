"""Atum check-ins: the default assistant's heartbeat, Hermes's side (cron/check_ins.py).

Behaviour contracts, driven through the real cron store and scheduler entry points:

* the job is seeded once per home and never comes back after the person removed it;
* retained gate/precheck/answer helpers validate their inputs and stay bounded;
* while the platform-managed scheduler takes ownership, native cron refuses the fixed
  check-in job before generic worker, model, tool, or delivery machinery;
* ordinary cron jobs retain their canonical native path.
"""

import json
import os
import time
from unittest.mock import MagicMock, patch

import pytest

from cron import check_ins
from cron.check_ins import CHECK_IN_JOB_ID, Gate


@pytest.fixture
def home(tmp_path, monkeypatch):
    hermes_home = tmp_path / ".hermes"
    (hermes_home / "cron" / "output").mkdir(parents=True)
    (hermes_home / "memories").mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))

    import cron.jobs as jobs_mod

    monkeypatch.setattr(jobs_mod, "HERMES_DIR", hermes_home)
    monkeypatch.setattr(jobs_mod, "CRON_DIR", hermes_home / "cron")
    monkeypatch.setattr(jobs_mod, "JOBS_FILE", hermes_home / "cron" / "jobs.json")
    monkeypatch.setattr(jobs_mod, "OUTPUT_DIR", hermes_home / "cron" / "output")
    return hermes_home


def _gate(**overrides) -> Gate:
    values = dict(
        slot="check",
        claimed_at=1_700_000_000_000,
        since=0,
        day="2026-10-04",
        locale="vi",
        now_local="2026-10-04T10:00:00+07:00",
        model=check_ins.CHECK_IN_MODEL,
        sent=[],
        muted=[],
        nudges_left=3,
        watched=[],
        signals=[],
    )
    values.update(overrides)
    return Gate(**values)


def _answer(**overrides) -> str:
    value = {
        "kind": "deadline",
        "key": "quote-lan",
        "text": "Báo giá cho chị Lan hết hạn chiều nay.",
        "source": "files",
        "ref": "Atum/quote.md",
        "action": "draft",
    }
    value.update(overrides)
    return json.dumps(value, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Seeding
# ---------------------------------------------------------------------------


def test_the_job_is_seeded_once_and_runs_on_the_check_in_model(home):
    from cron.jobs import get_job, load_jobs

    assert check_ins.ensure_job() == {"job_id": CHECK_IN_JOB_ID, "state": "created"}
    assert check_ins.ensure_job() == {"job_id": CHECK_IN_JOB_ID, "state": "present"}

    jobs = [job for job in load_jobs() if job["id"] == CHECK_IN_JOB_ID]
    assert len(jobs) == 1, "a second ensure never adds a second job"
    job = get_job(CHECK_IN_JOB_ID)
    assert job["model"] == check_ins.CHECK_IN_MODEL
    assert job["deliver"] == "matrix"
    assert job["enabled"] is True and job["next_run_at"]


def test_a_removed_job_is_not_seeded_again_unless_the_person_turns_check_ins_on(home):
    from cron.jobs import get_job, remove_job

    check_ins.ensure_job()
    assert remove_job(CHECK_IN_JOB_ID)

    assert check_ins.ensure_job() == {"job_id": None, "state": "removed"}
    assert get_job(CHECK_IN_JOB_ID) is None

    assert check_ins.ensure_job(force=True)["state"] == "created"
    assert get_job(CHECK_IN_JOB_ID) is not None


# ---------------------------------------------------------------------------
# The assistant's own cron tool: the owner's setting in the app decides
# ---------------------------------------------------------------------------


def test_asking_the_assistant_to_remove_or_pause_check_ins_turns_them_off_through_the_app(home):
    from cron.jobs import get_job
    from tools.cronjob_tools import cronjob

    check_ins.ensure_job()
    asked = []

    def host(event, payload, timeout):
        asked.append((event, payload))
        return json.dumps({"off": True})

    with patch.object(check_ins, "_host_request", side_effect=host):
        for action in ("remove", "pause"):
            result = json.loads(cronjob(action=action, job_id="Check-ins"))
            assert result["success"] is True and "Settings" in result["message"]

    assert asked == [(check_ins.OFF_EVENT, {"job_id": CHECK_IN_JOB_ID})] * 2
    job = get_job(CHECK_IN_JOB_ID)
    assert job is not None and job["enabled"] is True, "the ticker stays; the owner's setting is what turned off"


def test_without_the_app_the_check_in_job_stays_and_the_assistant_says_where_to_turn_it_off(home):
    from cron.jobs import get_job
    from tools.cronjob_tools import cronjob

    check_ins.ensure_job()

    for answer in ["", json.dumps({"off": False}), "not json"]:
        with patch.object(check_ins, "_host_request", return_value=answer):
            result = json.loads(cronjob(action="remove", job_id=CHECK_IN_JOB_ID))
        assert result["success"] is False and "Settings" in result["error"]
        assert get_job(CHECK_IN_JOB_ID) is not None


def test_the_check_in_job_is_never_edited_or_resumed_from_the_cron_tool(home):
    from cron.jobs import create_job, get_job
    from tools.cronjob_tools import cronjob

    check_ins.ensure_job()
    before = get_job(CHECK_IN_JOB_ID)

    with patch.object(check_ins, "_host_request") as host:
        for change in ({"action": "update", "schedule": "every 1d"}, {"action": "update", "prompt": "Email everyone"},
                       {"action": "resume"}):
            result = json.loads(cronjob(job_id=CHECK_IN_JOB_ID, **change))
            assert result["success"] is False and "Settings" in result["error"]

    host.assert_not_called()
    after = get_job(CHECK_IN_JOB_ID)
    assert (after["schedule_display"], after["prompt"]) == (before["schedule_display"], before["prompt"])

    # The person's own jobs are theirs to change as ever.
    own = create_job(prompt="Water the plants", schedule="every 2h", name="Plants")
    assert json.loads(cronjob(action="remove", job_id=own["id"]))["success"] is True
    assert get_job(own["id"]) is None


# ---------------------------------------------------------------------------
# The app's decision
# ---------------------------------------------------------------------------


def test_no_app_a_refusal_or_an_unreadable_answer_is_no_run(home):
    job = {"id": CHECK_IN_JOB_ID}

    for raw in ["", json.dumps({"run": False, "reason": "quiet_hours"}), "not json",
                json.dumps({"run": True, "slot": "nap", "claimed_at": 1, "day": "2026-10-04"})]:
        prepared = check_ins.prepare(job, request=lambda event, payload, timeout, raw=raw: raw)
        assert prepared.skip and prepared.gate is None


def test_the_gate_is_asked_as_the_host_event_with_the_job(home):
    calls = []

    def request(event, payload, timeout):
        calls.append((event, payload, timeout))
        return ""

    check_ins.ask_gate({"id": CHECK_IN_JOB_ID}, request)
    [(event, payload, timeout)] = calls
    assert event == check_ins.GATE_EVENT
    assert payload == {"job_id": CHECK_IN_JOB_ID}
    assert timeout <= 45


# ---------------------------------------------------------------------------
# The pre-check
# ---------------------------------------------------------------------------


def test_a_check_with_nothing_new_never_wakes_the_model(home, tmp_path):
    (home / "memories" / "USER.md").write_text("Owner: Minh. Works on Atum.", encoding="utf-8")
    folder = tmp_path / "Atum"
    folder.mkdir()
    (folder / "old.md").write_text("old notes", encoding="utf-8")
    later = int(time.time() * 1000) + 5_000

    pre = check_ins.precheck(_gate(since=later, watched=[str(folder)]), home=home)
    assert pre.wake is False and pre.reason == "nothing_new"


def test_a_changed_file_or_memory_wakes_a_check_with_its_name_and_first_lines(home, tmp_path):
    folder = tmp_path / "Atum"
    folder.mkdir()
    since = int(time.time() * 1000) - 60_000
    (folder / "quote.md").write_text("Quote for Lan\nDue Friday 17:00", encoding="utf-8")
    (folder / ".hidden.md").write_text("never read", encoding="utf-8")

    pre = check_ins.precheck(_gate(since=since, watched=[str(folder)]), home=home)
    assert pre.wake is True
    assert "Atum/quote.md" in pre.context and "Due Friday 17:00" in pre.context
    assert "never read" not in pre.context

    (home / "memories" / "MEMORY.md").write_text("Owner prefers short replies.", encoding="utf-8")
    pre = check_ins.precheck(_gate(since=since), home=home)
    assert pre.wake is True and "short replies" in pre.context


def test_the_brief_needs_something_to_brief_from(home):
    assert check_ins.precheck(_gate(slot="brief"), home=home).wake is False
    (home / "memories" / "USER.md").write_text("Owner: Minh.", encoding="utf-8")
    assert check_ins.precheck(_gate(slot="brief", since=int(time.time() * 1000)), home=home).wake is True


def test_the_context_stays_within_its_budget(home, tmp_path):
    folder = tmp_path / "Atum"
    folder.mkdir()
    for index in range(30):
        (folder / f"note-{index}.txt").write_text("x" * 5000, encoding="utf-8")
    (home / "memories" / "USER.md").write_text("y" * 9000, encoding="utf-8")

    pre = check_ins.precheck(_gate(watched=[str(folder)]), home=home)
    assert len(pre.context) <= check_ins.CONTEXT_MAX_CHARS


def test_nothing_new_settles_the_claim_as_skipped(home):
    events = []
    gate_answer = json.dumps({"run": True, "slot": "check", "claimed_at": 5, "since": int(time.time() * 1000) + 5000,
                              "day": "2026-10-04", "model": check_ins.CHECK_IN_MODEL})
    with patch("tui_gateway.server._broadcast_global_event", side_effect=lambda e, p: events.append((e, p))):
        prepared = check_ins.prepare({"id": CHECK_IN_JOB_ID}, request=lambda *_: gate_answer, home=home)
    assert prepared.skip and prepared.reason == "nothing_new"
    assert events == [(check_ins.SETTLED_EVENT, {"claimed_at": 5, "slot": "check", "outcome": "skipped"})]


# ---------------------------------------------------------------------------
# This Mac's daily ceiling
# ---------------------------------------------------------------------------


def test_this_mac_never_runs_more_than_the_daily_cap(home):
    allowed = [check_ins.take_local_run("2026-10-04") for _ in range(check_ins.DAILY_RUN_CAP + 3)]
    assert allowed.count(True) == check_ins.DAILY_RUN_CAP
    assert allowed[-1] is False
    assert check_ins.take_local_run("2026-10-05") is True, "a new day starts a new count"


# ---------------------------------------------------------------------------
# The answer
# ---------------------------------------------------------------------------


def test_only_a_well_formed_nudge_is_delivered():
    gate = _gate()
    for silence in ["[SILENT]", "  [SILENT]\n", "NO_REPLY", "", "Nothing to report today.", "{not json}"]:
        assert check_ins.parse_answer(silence, gate) is None, silence

    nudge = check_ins.parse_answer("Here you go: " + _answer(), gate)
    assert nudge == {
        "kind": "deadline",
        "key": "quote-lan",
        "text": "Báo giá cho chị Lan hết hạn chiều nay.",
        "source": "files",
        "ref": "quote.md",
        "action": "draft",
    }
    envelope = json.loads(check_ins.envelope(nudge, gate))
    assert envelope["v"] == 1
    assert envelope["check_in"]["claimed_at"] == gate.claimed_at and envelope["check_in"]["slot"] == "check"


def test_a_muted_kind_or_an_item_already_mentioned_stays_silent():
    assert check_ins.parse_answer(_answer(), _gate(muted=["deadline"])) is None
    assert check_ins.parse_answer(_answer(), _gate(sent=[{"key": "quote-lan", "text": "older"}])) is None
    assert check_ins.parse_answer(
        _answer(key="another-key"),
        _gate(sent=[{"key": "x", "text": "Báo giá cho chị Lan hết hạn chiều nay."}]),
    ) is None


def test_the_brief_is_always_a_brief_and_a_check_never_is():
    assert check_ins.parse_answer(_answer(kind="deadline"), _gate(slot="brief"))["kind"] == "brief"
    assert check_ins.parse_answer(_answer(kind="brief"), _gate(slot="check")) is None
    assert check_ins.parse_answer(_answer(kind="gossip"), _gate()) is None


def test_odd_fields_are_bounded_or_defaulted():
    nudge = check_ins.parse_answer(
        _answer(text="a" * 900, key="", source="slack", action="send", ref="/home/example/Documents/Plan.docx"), _gate()
    )
    assert len(nudge["text"]) <= 280 and nudge["text"].endswith("…")
    assert nudge["key"].startswith("k-"), "a missing key is derived from the text"
    assert nudge["source"] == "files" and nudge["ref"] == "Plan.docx"
    assert nudge["action"] == "review", "an action outside draft/prepare/review is never offered"


# ---------------------------------------------------------------------------
# The run itself: run_job with a mocked agent
# ---------------------------------------------------------------------------


def _check_in_job(**overrides):
    job = check_ins._job_record()
    job.update(overrides)
    return job


def test_seeded_check_in_runs_one_sealed_call_through_native_cron(home):
    from cron import scheduler

    prepared = check_ins.PreparedRun(skip=False, reason="changed", gate=_gate(), prompt="sealed check-in prompt")
    setup = scheduler._CronAgentSetup(
        model=check_ins.CHECK_IN_MODEL,
        runtime={},
        max_iterations=99,
        fallback_model=[{"provider": "other", "model": "other"}],
    )
    agent = MagicMock()
    agent.tools = [{"type": "function", "function": {"name": "terminal"}}]
    agent.valid_tool_names = {"terminal"}

    with patch.object(check_ins, "prepare", return_value=prepared), \
         patch("cron.scheduler._prepare_job_prompt", return_value=(None, "stored job prompt")), \
         patch("cron.scheduler._load_cron_job_config", return_value=MagicMock(cfg={}, model="tampered")), \
         patch("cron.scheduler._resolve_cron_agent_setup", return_value=setup), \
         patch("cron.scheduler._open_cron_session_db", return_value=MagicMock()), \
         patch("cron.scheduler._finalize_cron_session"), \
         patch("cron.scheduler._reload_dotenv_and_publish_delivery_target"), \
         patch("cron.scheduler._run_agent_with_watchdog", return_value={"final_response": _answer()} ) as run, \
         patch("run_agent.AIAgent", return_value=agent) as agent_cls:
        success, _output, final, error = scheduler.run_job(
            _check_in_job(model="tampered", enabled_toolsets=["terminal"]),
            native_claimed=True,
        )

    kwargs = agent_cls.call_args.kwargs
    assert kwargs["enabled_toolsets"] == []
    assert kwargs["max_iterations"] == 1
    assert kwargs["fallback_model"] is None
    assert kwargs["max_tokens"] == check_ins.ANSWER_MAX_TOKENS
    assert kwargs["skip_context_files"] is True and kwargs["skip_memory"] is True
    assert agent.tools == [] and agent.valid_tool_names == set()
    assert run.call_args.args[1] == prepared.prompt
    assert success is True and error is None
    assert json.loads(final)["check_in"]["key"] == "quote-lan"


def test_check_in_host_request_uses_the_native_server_request_registry():
    with patch("tui_gateway.server_requests.request_host", return_value='{"run":false}') as request:
        assert check_ins._host_request(check_ins.GATE_EVENT, {"job_id": CHECK_IN_JOB_ID}, 0.01) == '{"run":false}'
    request.assert_called_once_with(check_ins.GATE_EVENT, {"job_id": CHECK_IN_JOB_ID}, timeout=0.01)


def test_desktop_can_ensure_the_check_in_job_through_the_split_gateway(home):
    from tui_gateway import server

    result = server.handle_request({"id": "ensure", "method": "heartbeat.ensure", "params": {"force": True}})
    assert result["result"] == {"job_id": CHECK_IN_JOB_ID, "state": "created"}


def test_ordinary_cron_jobs_keep_the_canonical_native_path():
    from cron.scheduler import run_job

    job = {"id": "ordinary-job", "prompt": "ordinary", "no_agent": False}
    expected = (True, "ordinary-doc", "ordinary-answer", None)
    with patch("cron.scheduler_authority.run_canonical_job", return_value=expected) as canonical:
        assert run_job(job, execution_id="ordinary-execution") == expected
    canonical.assert_called_once()


def test_the_empty_toolset_holds_none_of_the_tools_every_other_turn_has():
    from model_tools import get_tool_definitions

    everything = {tool["function"]["name"] for tool in get_tool_definitions(enabled_toolsets=None, quiet_mode=True)}
    assert {"terminal", "write_file"} <= everything, "the registry does hold outward tools"
    assert get_tool_definitions(enabled_toolsets=list(check_ins.CHECK_IN_TOOLSETS), quiet_mode=True) == []
