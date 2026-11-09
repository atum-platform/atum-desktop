import re
from pathlib import Path


def test_discovery_skill_has_small_metadata_and_standard_sections():
    source = (Path(__file__).resolve().parents[2] / "skills/productivity/atum-discovery/SKILL.md").read_text()
    description = re.search(r"^description: (.*)$", source, re.MULTILINE).group(1)
    assert len(description) <= 60 and description.endswith(".")
    assert "author:" in source
    sections = ["When to Use", "Prerequisites", "How to Run", "Quick Reference", "Procedure", "Pitfalls", "Verification"]
    positions = [source.index(f"## {section}") for section in sections]
    assert positions == sorted(positions)
    assert "atum_store" in source and "atum_apps" in source
    assert "micro-Protons" in source and "consent" in source
