"""Signature pins shared by webhook configuration and CLI admission."""

SIGNATURE_SCHEMES = ("auto", "svix", "linear", "github", "gitlab", "v2", "v1")


def validate_signature_pin(name: str, route: dict) -> None:
    scheme = route.get("signature", "auto")
    if scheme not in SIGNATURE_SCHEMES:
        raise ValueError(f"Webhook route '{name}' has invalid signature pin. "
                         f"Choose one of {', '.join(SIGNATURE_SCHEMES)}.")
