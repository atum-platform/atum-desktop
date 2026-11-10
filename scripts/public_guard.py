#!/usr/bin/env python3
"""Read raw git objects; never run candidate code. Policy must be reviewed/trusted."""
import argparse
import hashlib
import fnmatch
from collections import Counter
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile

VERSION = '8.30.1'
# Generic identifier classes only; secret adjudication is never supported.
PATTERNS = [r'/Users/[^/\s"\']+', r'/home/[^/\s"\']+/',
            r'[\w.-]+\.ts\.net', r'100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+',
            r'arn:aws:', r'\bi-[0-9a-f]{8,17}\b', r'\b\d{12}\b',
            r'[\w.+-]+@[\w.-]+\.[a-z]{2,}',
            r'[a-z]{20}\.supabase\.co',
            r'\b[\w-]+(?:\.[\w-]+)*\.(?:internal|local|lan)\b']
ROLE_ADDRESSES = {'engineering', 'security', 'support', 'hello', 'info',
                  'contact', 'privacy', 'legal', 'noreply', 'no-reply', 'help'}

def git(*args):
    return subprocess.check_output(['git', *args])

def identifiers(data):
    text = data.decode('utf-8', errors='replace')
    return Counter((i, m.group().lower()) for i, p in enumerate(PATTERNS)
                   for m in re.finditer(p, text, re.IGNORECASE)
                   if not (i == 7 and m.group().split('@')[0].lower() in ROLE_ADDRESSES))

def tree(ref):
    result = {}
    for row in git('ls-tree', '-rz', '--full-tree', ref).split(b'\0'):
        if row:
            meta, path = row.split(b'\t', 1)
            mode, kind, oid = meta.decode().split()
            result[os.fsdecode(path)] = (mode, kind, oid)
    return result

def check_path(path, mode, policy):
    parts = PurePosixPath(path).parts
    if any(p in policy['denied_components'] or p.startswith('.env') for p in parts):
        raise ValueError('credential/generated/private path')
    if any(path == p.rstrip('/') or path.startswith(p.rstrip('/') + '/')
           for p in policy['denied_prefixes']):
        raise ValueError('private path prefix')
    if any(fnmatch.fnmatchcase(path.lower(), pattern)
           for pattern in policy['denied_globs']):
        raise ValueError('private path glob')
    if any(re.search(pattern, path) for pattern in policy['denied_regexes']):
        raise ValueError('private path pattern')
    if mode not in ('100644', '100755'):
        raise ValueError('symlink or submodule')

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base', required=True)
    p.add_argument('--head', default='HEAD')
    p.add_argument('--policy', type=Path, default=Path(__file__).with_name('public-boundary.json'))
    a = p.parse_args()
    policy = json.loads(a.policy.read_text(encoding='utf-8-sig'))
    base = git('rev-parse', '--verify', a.base + '^{commit}').decode().strip()
    head = git('rev-parse', '--verify', a.head + '^{commit}').decode().strip()
    anchor = policy['anchor']
    subprocess.run(['git', 'merge-base', '--is-ancestor', anchor, base], check=True)
    # No grafts/replacement objects, shallow histories or second/private roots.
    if git('rev-parse', '--is-shallow-repository').strip() != b'false':
        raise ValueError('full history required')
    if git('replace', '-l').strip() or Path(git('rev-parse', '--git-path', 'info/grafts').decode().strip()).exists():
        raise ValueError('replacement/grafted ancestry forbidden')
    if set(git('rev-list', '--max-parents=0', head).decode().split()) != {policy['root']}:
        raise ValueError('unapproved ancestry')
    commits = git('rev-list', '--reverse', head, '^' + base).decode().split()
    seen = set()
    for commit in commits:
        current = tree(commit)
        parents = git('rev-list', '--parents', '-n', '1', commit).decode().split()[1:]
        previous = tree(parents[0]) if parents else {}
        for path, (mode, kind, oid) in current.items():
            if kind != 'blob':
                raise ValueError('non-blob object')
            if previous.get(path) == current[path] or (path, oid) in seen:
                continue
            check_path(path, mode, policy)
            size = int(git('cat-file', '-s', oid))
            if size > policy['max_blob_bytes']:
                raise ValueError('blob exceeds size sanity limit')
            data = git('cat-file', 'blob', oid)
            old = git('cat-file', 'blob', previous[path][2]) if path in previous else b''
            # Existing approved identifiers do not grant permission to add more.
            reviewed = policy.get('reviewed_blobs', {}).get(path) == hashlib.sha256(data).hexdigest()
            policy_bytes = path == 'scripts/public-boundary.json' and data == a.policy.read_bytes()
            if not reviewed and not policy_bytes and identifiers(data) - identifiers(old):
                raise ValueError('new identifier/private marker in ' + path + ': review required (values redacted)')
            seen.add((path, oid))
    if subprocess.check_output(['gitleaks', 'version']).decode().strip().removeprefix('v') != VERSION:
        raise ValueError('install pinned gitleaks ' + VERSION)
    with tempfile.TemporaryDirectory(prefix='public-guard-') as tmp:
        config = Path(tmp) / 'config.toml'
        config.write_text('[extend]\nuseDefault = true\n', encoding='utf-8')
        ignore = Path(tmp) / 'ignore'
        ignore.touch()
        env = {k: v for k, v in os.environ.items() if not k.startswith('GITLEAKS_')}
        common = ['--config', str(config), '--gitleaks-ignore-path', str(ignore),
                  '--ignore-gitleaks-allow', '--redact=100', '--no-banner']
        report = Path(tmp) / 'findings.json'
        subprocess.run(['gitleaks', 'git', '.', '--log-opts=' + base + '..' + head + ' --full-history', *common,
                        '--report-format', 'json', '--report-path', str(report), '--exit-code', '0'], check=True, env=env)
        # A finding is accepted only when the exact file bytes it sits in were reviewed and recorded
        # in the base branch's policy (public keys, digests in test vectors); anything else fails.
        reviewed_secret = policy.get('reviewed_secret_blobs', {})
        unreviewed = []
        for f in json.loads(report.read_text(encoding='utf-8') or '[]'):
            blob = git('show', f['Commit'] + ':' + f['File'])
            if f['File'] == 'scripts/public-boundary.json':
                # The policy records reviewed digests; only `"path": "<sha256>"` lines may match.
                line = blob.decode('utf-8', 'replace').splitlines()[f['StartLine'] - 1]
                if re.fullmatch(r'\s*"[^"]+": "[0-9a-f]{64}",?\s*', line):
                    continue
            if reviewed_secret.get(f['File']) != hashlib.sha256(blob).hexdigest():
                unreviewed.append(f['File'] + ':' + str(f['StartLine']) + ' ' + f['RuleID'])
        if unreviewed:
            raise ValueError('unreviewed secret-scan findings (values redacted): ' + ', '.join(sorted(set(unreviewed))[:20]))
        for commit in commits:
            metadata = git('show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%B', commit)
            # Author emails are intentionally subject to coordinator identity review;
            # scan all metadata for secrets and message text for identifiers.
            message = git('show', '-s', '--format=%B', commit)
            if identifiers(message):
                raise ValueError('identifier in commit message (redacted)')
            subprocess.run(['gitleaks', 'stdin', *common], input=metadata, check=True, env=env)
    print(f'PASS: {len(commits)} new commits; raw paths/modes, ancestry, identifiers, secrets and metadata')

if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as exc:
        raise SystemExit('Public outbound guard denied: ' + str(exc))
