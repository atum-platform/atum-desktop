"""The sandbox's read tool for the SQL -> cloud processor seam. It talks to the real task broker over HTTP.

Only the first-run config arrives on stdin; the broker URL and capability come from the process
environment exactly as the sandbox receives them. There is no Google credential file to read.
"""
import json
import os
import sys
import tempfile
from pathlib import Path

payload = json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix="atum-google-read-proof-") as root:
    os.environ["HERMES_HOME"] = root
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    import yaml
    Path(root, "config.yaml").write_text(yaml.safe_dump(payload["config"]))
    from tools.atum_google_tool import atum_google_readonly
    result = {"calendar": json.loads(atum_google_readonly({"action": "agenda", "when": "today"})),
              "mail": json.loads(atum_google_readonly({"action": "search_mail", "query": "in:inbox is:unread"})),
              "drive": json.loads(atum_google_readonly({"action": "search_drive", "query": "recent project"})),
              "write": json.loads(atum_google_readonly({"action": "send_email", "to": ["x@example.test"]}))}
    json.dump(result, sys.stdout)
