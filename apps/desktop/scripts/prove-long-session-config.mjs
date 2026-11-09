// Real Atum setup payloads through Hermes' config endpoint and loader, with no model calls.
// Run from any directory: node apps/desktop/scripts/prove-long-session-config.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const temporary = mkdtempSync(path.join(os.tmpdir(), 'atum-long-session-config-'))
try {
  const bundled = path.join(temporary, 'setup.mjs')
  await build({
    entryPoints: [path.join(root, 'apps/desktop/electron/matrix/hermes-setup.ts')],
    outfile: bundled,
    bundle: true,
    platform: 'node',
    format: 'esm'
  })
  const setup = await import(pathToFileURL(bundled).href)
  const cases = []
  for (const mode of ['fresh-managed', 'fresh-own', 'existing-managed', 'existing-own']) {
    const writes = []
    const connection = {
      api: async (route, body) => {
        if (route === '/api/config') writes.push(body.config)
      },
      gateway: { request: async method => (method === 'setup.runtime_check' ? { ok: true } : { ready: true }) }
    }
    const signal = new AbortController().signal
    if (mode.startsWith('fresh')) {
      const configure = mode.endsWith('managed') ? setup.configureMatrixManagedModel : setup.configureMatrixHermes
      await configure(connection, { baseUrl: 'http://127.0.0.1:1234/v1', model: 'test-model', apiKey: '' }, signal)
      await setup.applyMatrixFullHermes(connection, signal)
    } else {
      await setup.applyMatrixManagedDefaults(connection, signal, mode.endsWith('managed'))
    }
    assert(writes.length > 0)
    for (const config of writes) {
      assert.deepEqual(config.compression, { protect_first_n: 0 })
    }
    cases.push({ mode, writes })
  }
  const payload = path.join(temporary, 'payload.json')
  writeFileSync(payload, JSON.stringify(cases))
  // The wrapper runs this temporary test with its clean CI environment. Only actual
  // JSON payloads cross the language seam; the test never reads TypeScript source.
  const test = path.join(temporary, 'test_long_session_config.py')
  writeFileSync(
    test,
    `
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(root)})
CASES = json.loads(Path(${JSON.stringify(payload)}).read_text())

def test_real_setup_payloads_preserve_hermes_compression(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    from hermes_cli.config import DEFAULT_CONFIG, load_config, read_raw_config, save_config
    from hermes_cli.web_server import ConfigUpdate, update_config

    for case in CASES:
        for customized in (False, True):
            compression = ({"threshold": 0.42, "threshold_tokens": 16000,
                            "protect_last_n": 11, "protect_first_n": 3}
                           if customized else {})
            initial = {"compression": compression, "agent": {"max_turns": 37},
                       "model": {"provider": "test-provider", "default": "test-model",
                                 "context_length": 196608}}
            save_config(initial, strip_defaults=False)
            before = load_config()["compression"]
            for config in case["writes"]:
                result = asyncio.run(update_config(ConfigUpdate(config=config)))
                assert result == {"ok": True}
            after = load_config()
            assert after["compression"] == {**before, "protect_first_n": 0}
            assert read_raw_config()["compression"]["protect_first_n"] == 0
            assert after["agent"]["max_turns"] == 37
            assert after["model"]["provider"] == "test-provider"
            if case["mode"].endswith("own"):
                assert after["model"]["context_length"] == 196608
            if not customized:
                assert after["compression"]["threshold"] == DEFAULT_CONFIG["compression"]["threshold"]
            # Applying the same setup a second time is idempotent.
            for config in case["writes"]:
                asyncio.run(update_config(ConfigUpdate(config=config)))
            assert load_config()["compression"] == after["compression"]
`
  )
  const result = spawnSync('bash', [path.join(root, 'scripts/run_tests.sh'), '-j', '1', test, '--file-retries', '0'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    timeout: 180_000
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, 'Hermes config endpoint/loader proof must complete successfully')
  console.log('PASS: four setup paths, default/custom compression, persistence and idempotence; no provider calls.')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
