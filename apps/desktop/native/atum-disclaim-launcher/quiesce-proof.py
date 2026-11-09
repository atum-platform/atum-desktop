"""Synthetic Mac proof: stop an escaped writer before freezing its output.

Usage: python3 quiesce-proof.py /absolute/path/to/atum-disclaim-launcher
No owner identity, enrollment, credentials, network or production filesystem is used.
"""
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time

launcher = str(Path(sys.argv[1]).resolve(strict=True))
with tempfile.TemporaryDirectory(prefix="atum-quiesce-") as directory:
    target = Path(directory) / "output.txt"
    source = r'''
import json, os, sys, time
file = sys.argv[1]
child = os.fork()
if child == 0:
    os.setsid()
    while True:
        with open(file, 'ab', buffering=0) as stream:
            stream.write(b'x')
        time.sleep(0.002)
print(json.dumps({'host': os.getpid(), 'daemon': child}), flush=True)
while True:
    time.sleep(1)
'''
    process = subprocess.Popen([launcher, "--", "/usr/bin/python3", "-u", "-c", source, str(target)],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    facts = None
    try:
        assert select.select([process.stdout], [], [], 5)[0], "host did not become ready"
        facts = json.loads(process.stdout.readline())
        deadline = time.monotonic() + 5
        while not target.exists() or target.stat().st_size < 10:
            assert time.monotonic() < deadline, "writer did not run"
            time.sleep(0.01)
        # The daemon has left its parent's process group; a group kill is insufficient.
        assert os.getpgid(facts['host']) != os.getpgid(facts['daemon'])
        receipt = json.loads(subprocess.check_output([launcher, "--quiesce", str(facts['host'])], timeout=5))
        assert receipt['quiescent'] is True
        assert facts['daemon'] in receipt['killed']
        frozen = target.read_bytes()
        time.sleep(0.15)
        assert frozen and target.read_bytes() == frozen, "writer survived the collection fence"
        process.wait(timeout=5)
        print(json.dumps({'quiescent': True, 'escapedWriterStopped': True, 'frozenBytesStable': True}))
    finally:
        for pid in (facts or {}).values():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
