/** Real processes, temporary HOME, synthetic credentials and a loopback-only
 * refresh rejection. Run with the repo Python environment; no paid provider. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  clearMatrixHermesCredentials,
  forgetMatrixAccountCodex,
  matrixAccountCodexScope,
  matrixHermesEnvironment,
  matrixHermesHome
} from '../electron/matrix/hermes-runtime'
import { readMatrixPlanAcknowledgment, saveMatrixPlanAcknowledgment } from '../electron/matrix/plan-acknowledgment'

const source = path.resolve(import.meta.dirname, '../../..')
const script = fileURLToPath(import.meta.url)

async function worker(root: string) {
  const person = path.join(root, 'person')
  assert.equal(os.homedir(), person)

  const python =
    [path.join(source, '.venv/bin/python'), path.join(source, 'venv/bin/python')].find(existsSync) ?? 'python3'

  const config = { python, source, profiles: path.join(root, 'profiles'), workspaceHome: person }
  const mine = matrixAccountCodexScope(config, 'owner-a')
  const canaryFile = path.join(person, '.codex/auth.json')

  const token =
    'eyJhbGciOiJub25lIn0.' +
    Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') +
    '.synthetic'

  const canary = JSON.stringify({ tokens: { access_token: token, refresh_token: 'synthetic-cli-canary' } })
  mkdirSync(path.dirname(canaryFile), { recursive: true })
  writeFileSync(canaryFile, canary)
  const homes = ['executor-a', 'executor-b'].map(executor => matrixHermesHome(config, 'owner-a', executor))

  const environment = (owner: string, home: string) =>
    matrixHermesEnvironment(
      config,
      home,
      path.join(root, 'workspace'),
      {
        HOME: person,
        PATH: process.env.PATH,
        TMPDIR: root,
        NO_PROXY: '127.0.0.1,localhost'
      },
      matrixAccountCodexScope(config, owner)
    )

  const runPython = (home: string, code: string, owner = 'owner-a', cliControl = false) =>
    JSON.parse(
      execFileSync(python, ['-s', '-P', '-B', '-c', code], {
        cwd: source,
        env: {
          ...environment(owner, home),
          ...(cliControl ? { CODEX_HOME: path.join(person, '.codex') } : {})
        },
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 128 * 1024
      })
    ) as Record<string, unknown>

  const seed = `
import json
from hermes_cli import auth
auth._save_codex_tokens({'access_token': 'synthetic-owned-token', 'refresh_token': 'synthetic-owned-refresh'})
print(json.dumps({'seeded': True}))
`

  for (const home of homes) {
    assert.deepEqual(runPython(home, seed), { seeded: true })
  }

  saveMatrixPlanAcknowledgment(config, 'owner-a', {
    provider: 'openai-codex',
    policyVersion: '2026-10-06',
    acknowledgedAt: '2026-10-07'
  })
  // Positive control: the canary is importable when deliberately selected in
  // this separate synthetic process. The normal native launch must not adopt it.
  assert.deepEqual(
    runPython(
      homes[0]!,
      `
import json
from hermes_cli import auth
tokens = auth._import_codex_cli_tokens()
print(json.dumps({'canaryUsable': bool(tokens and tokens['refresh_token'] == 'synthetic-cli-canary')}))
`,
      'owner-a',
      true
    ),
    { canaryUsable: true }
  )

  const rejection = runPython(
    homes[0]!,
    `
import json, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from hermes_cli import auth
requests = []
class Rejected(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        assert b'synthetic-owned-refresh' in body
        requests.append(self.path)
        self.send_response(401)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"error":"invalid_grant"}')
    def log_message(self, *args):
        pass
server = ThreadingHTTPServer(('127.0.0.1', 0), Rejected)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
auth.CODEX_OAUTH_TOKEN_URL = f'http://127.0.0.1:{server.server_port}/token'
try:
    auth.resolve_codex_runtime_credentials(force_refresh=True)
    raise AssertionError('refresh rejection adopted another account')
except auth.AuthError as error:
    assert error.code == 'invalid_grant'
finally:
    server.shutdown()
    server.server_close()
assert auth._read_codex_tokens()['tokens']['refresh_token'] == 'synthetic-owned-refresh'
assert auth._import_codex_cli_tokens() is None
print(json.dumps({'refreshRequests': len(requests), 'rejected': True, 'canaryAdopted': False}))
`
  )

  assert.deepEqual(rejection, { refreshRequests: 1, rejected: true, canaryAdopted: false })

  const status = `
import json
from hermes_cli import auth
print(json.dumps({'connected': auth.get_codex_auth_status()['logged_in']}))
`

  assert.deepEqual(runPython(matrixHermesHome(config, 'owner-b', 'executor-a'), status, 'owner-b'), {
    connected: false
  })
  // The same native cleanup order as sign-out: remove shared consent/tokens,
  // settle and clear every retained profile, remove shared state once more.
  forgetMatrixAccountCodex(config, 'owner-a')

  for (const home of homes) {
    await clearMatrixHermesCredentials(config, home)
  }

  forgetMatrixAccountCodex(config, 'owner-a')
  assert.equal(existsSync(path.join(mine.authDir, 'codex_auth.json')), false)
  assert.equal(readMatrixPlanAcknowledgment(config, 'owner-a', 'openai-codex'), undefined)

  for (const home of homes) {
    const auth = JSON.parse(readFileSync(path.join(home, 'auth.json'), 'utf8'))
    assert.equal(auth.providers?.['openai-codex'], undefined)
    assert.equal(auth.credential_pool?.['openai-codex'], undefined)
    assert.deepEqual(runPython(home, status), { connected: false })
  }

  assert.equal(readFileSync(canaryFile, 'utf8'), canary)

  return {
    proof: 'connection-account-isolation',
    result: 'pass',
    refreshRequests: 1,
    profileCopiesRemoved: homes.length,
    otherAccountDisconnected: true,
    codexCanaryUnchanged: true
  }
}

if (process.argv[2] === '--worker') {
  const root = process.argv[3]!
  assert.ok(path.isAbsolute(root) && root.includes('atum-connection-proof-'))
  console.log(JSON.stringify(await worker(root)))
} else {
  const root = mkdtempSync(path.join(os.tmpdir(), 'atum-connection-proof-'))

  try {
    mkdirSync(path.join(root, 'person'))

    const output = execFileSync(process.execPath, [...process.execArgv, script, '--worker', root], {
      cwd: source,
      env: { ...process.env, HOME: path.join(root, 'person') },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 128 * 1024
    })

    console.log(output.trim())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
