"""Product labels for the managed ACP inventory and current-model fallback."""

ATUM_PROVIDERS = frozenset({"atum-managed", "atum-gateway"})

# Atum's served line-up, in picker order (apps/desktop/shared/matrix-models.ts MATRIX_MODEL_LINEUP).
ATUM_LINEUP = (("nguyet-thuc", "Nguyệt Thực 1.3"), ("nhat-thuc", "Nhật Thực 1.1"))

# Names a profile may still hold from before the line-up; they run as the everyday model.
ATUM_RETIRED = {"binh-minh": "nguyet-thuc"}


def model_display_name(provider: str, model: str, fallback: str) -> str:
    if provider in ATUM_PROVIDERS:
        return dict(ATUM_LINEUP).get(model, fallback)
    return fallback
