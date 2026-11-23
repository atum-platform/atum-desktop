"""Product labels for the managed ACP inventory and current-model fallback."""


def model_display_name(provider: str, model: str, fallback: str) -> str:
    if provider in {"atum-managed", "atum-gateway"}:
        return {"nguyet-thuc": "Nguyệt Thực 1.3", "nhat-thuc": "Nhật Thực 1.1"}.get(model, fallback)
    return fallback

