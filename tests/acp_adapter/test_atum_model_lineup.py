"""A session on Atum's provider offers Atum's line-up, never the profile's raw inventory."""

from unittest.mock import patch

from acp_adapter.model_catalog import build_model_state


def test_atum_session_lists_only_the_lineup_by_product_name():
    with patch("hermes_cli.inventory.build_models_payload") as inventory:
        state = build_model_state("nguyet-thuc", "atum-managed", "")
    inventory.assert_not_called()
    assert [(m.model_id, m.name) for m in state.available_models] == [
        ("atum-managed:nguyet-thuc", "Nguyệt Thực 1.3"),
        ("atum-managed:nhat-thuc", "Nhật Thực 1.1"),
    ]
    assert state.current_model_id == "atum-managed:nguyet-thuc"


def test_retired_atum_name_selects_the_everyday_model():
    state = build_model_state("binh-minh", "atum-gateway", "")
    assert state.current_model_id == "atum-gateway:nguyet-thuc"
    assert state.current_model_id in {m.model_id for m in state.available_models}
