"""Behavioral contract for the canonical raw config reader."""


def test_read_user_config_raw_exists_and_documented():
    """Write-back callers have one explicit raw primitive with clear scope."""
    from hermes_cli.config import read_user_config_raw

    doc = read_user_config_raw.__doc__ or ""
    assert "ONLY legal for write-back round-trips and raw-file diagnostics" in doc
    assert "load_config()" in doc
