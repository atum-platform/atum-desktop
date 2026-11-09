"""cron/routines_mapper.py: every schedule form Hermes parses either becomes a routine schedule or is refused with a reason.

The input is the real ``cron.jobs.parse_schedule`` output, so a change to Hermes's parser that the mapper does not
know about shows up here as a behaviour change, not a snapshot mismatch.
"""

from __future__ import annotations

import pytest

from cron import routines_mapper as mapper
from cron.jobs import parse_schedule


def mapped(text: str) -> mapper.Mapped:
    return mapper.map_parsed_schedule(parse_schedule(text))


class TestOnce:
    def test_timestamp_with_offset_keeps_its_instant(self):
        result = mapped("2026-10-21T15:00:00+07:00")
        assert result.refusal is None
        assert result.schedule == {"kind": "once", "runAt": "2026-10-21T15:00:00+07:00"}

    def test_naive_timestamp_is_anchored_by_hermes_then_carries_an_offset(self):
        result = mapped("2026-10-21T15:00:00")
        assert result.schedule["kind"] == "once"
        assert result.schedule["runAt"].startswith("2026-10-21T15:00:00")
        assert result.schedule["runAt"][-6] in "+-"

    @pytest.mark.parametrize("duration", ["30m", "2h", "1d"])
    def test_duration_from_now_is_a_one_time_run(self, duration):
        result = mapped(f"in {duration}")
        assert result.refusal is None
        assert result.schedule["kind"] == "once"
        assert "." not in result.schedule["runAt"]  # microseconds are dropped; the contract reads seconds

    def test_a_run_time_without_an_offset_is_not_guessed(self):
        result = mapper.map_parsed_schedule({"kind": "once", "run_at": "2026-10-21T15:00:00"})
        assert result.schedule is None and "offset" in result.refusal

    def test_missing_or_unreadable_run_time_is_refused(self):
        assert mapper.map_parsed_schedule({"kind": "once"}).refusal
        assert mapper.map_parsed_schedule({"kind": "once", "run_at": "soon"}).refusal


class TestInterval:
    @pytest.mark.parametrize("text", ["every 1m", "every 15m", "every 30m", "every 59m"])
    def test_sub_hour_cadence_is_refused_with_the_money_reason(self, text):
        result = mapped(text)
        assert result.schedule is None
        assert "once an hour" in result.refusal

    def test_fractional_hours_are_refused(self):
        assert "whole number of hours" in mapped("every 90m").refusal

    def test_whole_hours_are_refused_while_emission_is_off(self):
        result = mapped("every 2h")
        assert result.schedule is None
        assert "daily, weekly or monthly" in result.refusal

    def test_whole_hours_map_to_interval_when_emission_is_on(self, monkeypatch):
        monkeypatch.setattr(mapper, "INTERVAL_EMISSION_ENABLED", True)
        assert mapped("every 2h").schedule == {"kind": "interval", "everyHours": 2}
        assert mapped("every 1d").schedule == {"kind": "interval", "everyHours": 24}
        assert mapped("every 1h").schedule == {"kind": "interval", "everyHours": 1}

    def test_the_contract_ceiling_is_one_year(self, monkeypatch):
        monkeypatch.setattr(mapper, "INTERVAL_EMISSION_ENABLED", True)
        assert mapped("every 365d").schedule == {"kind": "interval", "everyHours": 8760}
        assert "one year" in mapped("every 366d").refusal

    @pytest.mark.parametrize("parsed", [{"kind": "interval"}, {"kind": "interval", "minutes": 0}, {"kind": "interval", "minutes": True}])
    def test_unreadable_interval_is_refused(self, parsed):
        assert mapper.map_parsed_schedule(parsed).refusal


class TestCron:
    def test_daily(self):
        assert mapped("0 9 * * *").schedule == {"kind": "daily", "hour": 9, "minute": 0}
        assert mapped("30 7 * * *").schedule == {"kind": "daily", "hour": 7, "minute": 30}

    def test_weekly_list_and_range_in_iso_days(self):
        assert mapped("30 8 * * 1-5").schedule == {"kind": "weekly", "hour": 8, "minute": 30, "weekdays": [1, 2, 3, 4, 5]}
        assert mapped("0 9 * * 1,3,5").schedule["weekdays"] == [1, 3, 5]

    def test_sunday_is_seven_whether_written_as_zero_or_seven(self):
        assert mapped("0 9 * * 0").schedule["weekdays"] == [7]
        assert mapped("0 9 * * 7").schedule["weekdays"] == [7]
        assert mapped("0 9 * * 0,6").schedule["weekdays"] == [6, 7]

    def test_monthly_day_up_to_28(self):
        assert mapped("15 10 5 * *").schedule == {"kind": "monthly", "day": 5, "hour": 10, "minute": 15}
        assert mapped("0 0 28 * *").schedule["day"] == 28

    @pytest.mark.parametrize("text", ["0 9 29 * *", "0 9 31 * *"])
    def test_days_after_the_28th_are_refused(self, text):
        assert "days 1 to 28" in mapped(text).refusal

    @pytest.mark.parametrize(
        "text",
        ["*/15 * * * *", "0 * * * *", "0 */2 * * *", "0 9-17 * * *", "0,30 9 * * *", "* * * * *"],
    )
    def test_schedules_that_repeat_within_the_day_are_refused(self, text):
        result = mapped(text)
        assert result.schedule is None
        assert "within the day" in result.refusal

    def test_month_restriction_is_refused(self):
        assert "months" in mapped("0 9 1 6 *").refusal

    def test_day_of_month_and_weekday_together_are_refused(self):
        assert "both" in mapped("0 9 5 * 1").refusal

    @pytest.mark.parametrize("text", ["0 9 * * 1-5/2", "0 9 * * */2"])
    def test_unplain_weekdays_are_refused(self, text):
        assert mapped(text).schedule is None

    @pytest.mark.parametrize("expr", ["0 9 * * 8", "0 9 * * 5-1", "0 9 * * mon"])
    def test_weekdays_the_mapper_cannot_read_are_refused_even_if_parsed(self, expr):
        assert mapper.map_parsed_schedule({"kind": "cron", "expr": expr}).schedule is None

    @pytest.mark.parametrize("text", ["0 9 1,15 * *", "0 9 1-5 * *", "0 9 */2 * *"])
    def test_unplain_days_of_month_are_refused(self, text):
        assert mapped(text).schedule is None

    def test_a_six_field_expression_is_refused(self):
        assert "five-field" in mapped("0 0 9 * * *").refusal

    def test_no_raw_cron_survives_in_any_supported_result(self):
        for text in ("0 9 * * *", "0 9 * * 1-5", "0 9 5 * *"):
            assert "expr" not in mapped(text).schedule


def test_an_unknown_kind_is_refused():
    assert mapper.map_parsed_schedule({"kind": "lunar"}).refusal
    assert mapper.map_parsed_schedule({}).refusal


class TestFields:
    def test_plain_calls_pass(self):
        assert mapper.unsupported_fields({"prompt": "Brief me", "deliver": "origin", "skills": [], "script": ""}) is None
        assert mapper.unsupported_fields({"deliver": "local", "no_agent": False}) is None

    def test_explicit_empty_toolsets_are_not_silently_widened(self):
        reason = mapper.unsupported_fields({"enabled_toolsets": []})
        assert reason and "toolset restriction" in reason
        assert mapper.unsupported_fields({"enabled_toolsets": None}) is None

    @pytest.mark.parametrize(
        "field,value,words",
        [
            ("skill", "web", "skills"),
            ("skills", ["a"], "skills"),
            ("model", "gpt", "model"),
            ("provider", "openrouter", "provider"),
            ("base_url", "http://x", "base_url"),
            ("script", "x.py", "script"),
            ("context_from", "abc", "chaining"),
            ("enabled_toolsets", ["web"], "toolset"),
            ("workdir", "/tmp", "working directory"),
            ("no_agent", True, "no-agent"),
            ("attach_to_session", True, "session"),
            ("deliver", "telegram", "delivery target"),
        ],
    )
    def test_each_unsupported_field_is_named_in_the_reason(self, field, value, words):
        reason = mapper.unsupported_fields({field: value})
        assert reason and words in reason

    def test_several_are_named_together_and_duplicates_collapse(self):
        reason = mapper.unsupported_fields({"skill": "a", "skills": ["a"], "script": "x.py"})
        assert reason.count("attached skills") == 1 and "a pre-run script" in reason


class TestRepeat:
    def test_none_zero_and_negative_mean_forever(self):
        for value in (None, 0, -1):
            assert mapper.repeat_problem(value, {"kind": "daily"}) is None

    def test_one_is_fine_only_for_a_one_time_schedule(self):
        assert mapper.repeat_problem(1, {"kind": "once"}) is None
        assert mapper.repeat_problem(1, {"kind": "daily"})

    def test_a_count_is_refused(self):
        assert "repeat count" in mapper.repeat_problem(3, {"kind": "daily"})


class TestTitleAndDescription:
    def test_name_wins_then_instruction_words(self):
        assert mapper.build_title("Morning brief", "ignored") == "Morning brief"
        assert mapper.build_title(None, "  Summarise\nmy   inbox ") == "Summarise my inbox"
        assert mapper.build_title("", "") == "Scheduled task"

    def test_title_respects_the_contract_limit(self):
        title = mapper.build_title(None, "x" * 500)
        assert 1 <= len(title) <= mapper.TITLE_MAX

    def test_descriptions(self):
        assert mapper.describe_schedule({"kind": "daily", "hour": 8, "minute": 5}) == "daily 08:05"
        assert mapper.describe_schedule({"kind": "weekly", "hour": 9, "minute": 0, "weekdays": [1, 3]}) == "weekly Mon,Wed 09:00"
        assert mapper.describe_schedule({"kind": "monthly", "day": 5, "hour": 9, "minute": 0}) == "monthly day 5 09:00"
        assert mapper.describe_schedule({"kind": "interval", "everyHours": 6}) == "every 6h"
        assert mapper.describe_schedule({"kind": "once", "runAt": "2026-10-21T15:00:00+07:00"}).startswith("once at 2026")
