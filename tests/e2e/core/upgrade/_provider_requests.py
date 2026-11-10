"""Scope upgrade assertions to their turn on the module's shared provider."""


def requests_for_marker(provider, marker: str) -> list[dict]:
    # Cron jobs from a seeded home can call this same fake between CLI turns.
    # A global before/after count attributes that unrelated traffic to this turn.
    return [request for request in provider.main_requests()
            if any(message.get("role") == "user" and marker in str(message.get("content", ""))
                   for message in request.get("messages", []))]
