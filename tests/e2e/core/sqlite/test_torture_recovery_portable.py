"""Portable data/FTS replay of the corruption + fleet-kill sequence.

The Linux chamber additionally proves /proc fd and WAL-sidecar invariants. These
POSIX cases execute the same real roles and episode faults without claiming that
Linux-only kernel evidence on macOS.
"""
import contextlib
import random

import pytest

from tests.e2e.core.sqlite import _helpers as H
from tests.e2e.core.sqlite import test_torture_chamber as torture

pytestmark = pytest.mark.platforms("posix")


@pytest.fixture(scope="module", params=H.JOURNAL_MODES)
def chamber(request, tmp_path_factory):
    H.skip_unless_deployable(request.param)
    ch = H.Chamber(tmp_path_factory.mktemp(f"portable-{request.param}"), journal=request.param)
    try:
        torture._ensure_reader(ch)
        ch.spawn("writer", "seed", tag="seed", sessions=["seed"], max_appends=80)
        torture._reap_all(ch, ["seed"])
        yield ch
    finally:
        ch.shutdown()


@pytest.mark.parametrize("episode", ["fts_corruption_fail_open", "kill9_everything"])
def test_seeded_data_recovery(chamber, episode):
    seed = H.episode_seed(episode)
    context = f"journal={chamber.mode} episode={episode} seed={seed} base={H.base_seed()}"
    torture._ensure_reader(chamber)
    try:
        runs = torture.EPISODES[episode](chamber, episode, random.Random(seed))
    finally:
        for name, _ in chamber.live():
            if name != chamber.reader_name:
                with contextlib.suppress(AssertionError):
                    chamber.stop(name, deadline=30)
    assert not chamber.errors(), f"{context}: {chamber.errors()}"
    assert H.integrity_rows(chamber.db) == ["ok"], context
    assert not H.journal_mode_problems(chamber), context
    assert not H.exactly_once_problems(chamber), context
    tokens = H.acked_tokens(chamber, runs)
    assert tokens, context
    assert not H.fts_problems(chamber.db, H.sample(random.Random(seed), tokens, 12)), context
