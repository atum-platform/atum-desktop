"""Canonical comparison spelling for typed approval replies and catalog words.

NFC accepts canonically equivalent keyboard input. Preserve whole-message
matching, including internal whitespace and punctuation, and existing lowercasing.
"""

import unicodedata


def normalize_approval_input(text: str) -> str:
    """Strip surrounding whitespace and return a lowercase NFC comparison key."""
    return unicodedata.normalize("NFC", text.strip().lower())
