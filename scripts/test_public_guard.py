"""Real git and pinned scanner contract tests; temp repositories are removed."""
import json
import os
import textwrap
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('public_guard.py').resolve()

class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='guard-test-')
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Test Contributor')
        self.git('config', 'user.email', 'test@example.invalid')
        (self.repo / 'README.md').write_text('public text\n', encoding='utf-8')
        self.commit()
        self.root = self.git('rev-parse', 'HEAD').strip()
        self.policy = self.repo / '.git/policy.json'
        policy = json.loads(SCRIPT.with_name('public-boundary.json').read_text())
        policy.update(anchor=self.root, root=self.root, reviewed_blobs={})
        self.policy.write_text(json.dumps(policy), encoding='utf-8')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], stderr=subprocess.DEVNULL).decode()

    def commit(self, message='Public update'):
        self.git('add', '-A')
        self.git('commit', '-qm', message)

    def check(self, allowed):
        result = subprocess.run(['python3', str(SCRIPT), '--base', self.root,
            '--policy', str(self.policy)], cwd=self.repo, capture_output=True, check=False)
        self.assertEqual(result.returncode == 0, allowed, result.stderr.decode() + result.stdout.decode())

    def test_allowed(self):
        (self.repo/'README.md').write_text('public update\n', encoding='utf-8')
        self.commit()
        self.check(True)

    def test_denied_private_then_deleted(self):
        path = self.repo/'packages/cloud-controller/x.ts'
        path.parent.mkdir(parents=True)
        path.write_text('text', encoding='utf-8')
        self.commit()
        path.unlink()
        self.commit()
        self.check(False)

    def add_file(self, path, content='public text'):
        target = self.repo/path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')
        self.commit()

    def test_allowed_new_component(self):
        self.add_file('apps/desktop/src/new-component.tsx')
        self.check(True)

    def test_allowed_new_test(self):
        self.add_file('tests/test_new_feature.py')
        self.check(True)

    def test_allowed_role_address(self):
        self.add_file('CONTACT.md', 'support'+'@example.com')
        self.check(True)

    def test_denied_private_paths(self):
        for path in ['packages/cloud-controller/x.ts', 'packages/cloud-sandbox/x.ts',
                     'docs/session-logs/x.md', 'evidence/x.md', 'apps/web/new.ts',
                     'apps/bootstrap-installer/new.ts', 'scripts/publish-new.sh', 'scripts/releases/new-authority.py',
                     'apps/desktop/scripts/sign-macos.sh',
                     'skills/productivity/docx/SKILL.md', '.env', '.env.local',
                     'node_modules/a/index.js']:
            with self.subTest(path=path):
                self.git('reset', '--hard', self.root)
                self.git('clean', '-fdq')
                self.add_file(path)
                self.check(False)

    def test_denied_internal_hostname(self):
        self.add_file('README.md', 'host.'+'internal')
        self.check(False)

    def test_denied_tailnet_hostname(self):
        self.add_file('README.md', 'host.example.'+'ts.net')
        self.check(False)

    def test_denied_personal_email(self):
        self.add_file('README.md', 'person'+'@example.com')
        self.check(False)

    def test_denied_aws_key(self):
        self.add_file('README.md', 'aws_access_key_id = "AK'+'IA'+'Z7N4K2Q3R6M3T2V5"')
        self.check(False)

    def test_denied_size(self):
        policy = json.loads(self.policy.read_text())
        policy['max_blob_bytes'] = 32
        self.policy.write_text(json.dumps(policy))
        self.add_file('asset.bin', 'x' * 33)
        self.check(False)

    def test_denied_submodule(self):
        self.git('update-index', '--add', '--cacheinfo', '160000', self.root, 'vendor/module')
        self.git('commit', '-qm', 'Public update')
        self.check(False)

    def test_candidate_cannot_loosen_trusted_policy(self):
        policy = json.loads(self.policy.read_text())
        policy['denied_prefixes'] = []
        self.add_file('scripts/public-boundary.json', json.dumps(policy))
        self.add_file('packages/cloud-controller/x.ts')
        self.check(False)

    def test_preflight_uses_base_checker_and_policy(self):
        self.add_file('scripts/public_guard.py', SCRIPT.read_text())
        self.add_file('scripts/public-boundary.json', self.policy.read_text())
        self.root = self.git('rev-parse', 'HEAD').strip()
        self.add_file('scripts/public_guard.py', 'raise SystemExit(0)')
        self.add_file('scripts/public-boundary.json', '{}')
        self.add_file('packages/cloud-controller/x.ts')
        result = subprocess.run(['bash', str(SCRIPT.with_name('pre-push-public')),
                                 self.root, 'HEAD'], cwd=self.repo, capture_output=True, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'private path prefix', result.stderr)

    def test_bootstrap_reports_but_installed_guard_blocks(self):
        workflow = SCRIPT.parent.parent/'.github/workflows/public-guard.yml'
        command = textwrap.dedent(workflow.read_text().rsplit('        run: |', 1)[1])
        candidate = self.repo/'candidate'
        (candidate/'scripts').mkdir(parents=True)
        (candidate/'scripts/public_guard.py').write_text('raise SystemExit(1)')
        summary = self.repo/'summary'
        env = dict(os.environ, BASE_SHA=self.root, HEAD_SHA=self.root,
                   GITHUB_STEP_SUMMARY=str(summary))
        bootstrap = subprocess.run(['bash', '-e', '-c', command], cwd=candidate,
                                   env=env, capture_output=True, check=False)
        self.assertEqual(bootstrap.returncode, 0, bootstrap.stderr.decode())
        self.assertIn('report-only', summary.read_text())
        trusted = self.repo/'trusted/scripts'
        trusted.mkdir(parents=True)
        (trusted/'public_guard.py').write_text('raise SystemExit(1)')
        installed = subprocess.run(['bash', '-e', '-c', command], cwd=candidate,
                                   env=env, capture_output=True, check=False)
        self.assertNotEqual(installed.returncode, 0)

    def test_denied_symlink(self):
        (self.repo/'README.md').unlink()
        (self.repo/'README.md').symlink_to('other')
        self.commit()
        self.check(False)

    def test_denied_identifier(self):
        (self.repo/'README.md').write_text('/'+'Users'+'/someone/work\n', encoding='utf-8')
        self.commit()
        self.check(False)

    def test_denied_secret_even_with_reviewed_identifier_blob(self):
        import hashlib
        data = ('credential = "gh'+'p_'+'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'+'"\n').encode()
        (self.repo/'README.md').write_bytes(data)
        policy=json.loads(self.policy.read_text(encoding='utf-8'))
        policy['reviewed_blobs']={'README.md':hashlib.sha256(data).hexdigest()}
        self.policy.write_text(json.dumps(policy), encoding='utf-8')
        self.commit()
        self.check(False)

    def test_denied_metadata_secret(self):
        (self.repo/'README.md').write_text('update', encoding='utf-8')
        self.commit('credential gh'+'p_'+'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')
        self.check(False)

    def test_denied_unrelated_root(self):
        self.git('checkout', '--orphan', 'unrelated')
        self.commit('Independent root')
        self.check(False)

if __name__ == '__main__':
    unittest.main()
