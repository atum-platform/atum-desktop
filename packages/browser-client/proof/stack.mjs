// Disposable real MAS/Synapse. Generated private files never enter Git or tool output.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const runtime = join(here, '.runtime')
const env = { ...process.env, DOCKER_CONTEXT: 'colima', PROOF_UID: String(process.getuid()), PROOF_GID: String(process.getgid()) }
const project = 'atum-cx-browser-proof'
const masImage = 'ghcr.io/element-hq/matrix-authentication-service:1.24.0@sha256:52c18ffcc940220a3b6aa5985b7e09d24ac27f5ed10a4d660c312e48f73ff105'
const issuer = 'https://localhost:22981/'
const server = 'https://localhost:22909'
const serverName = 'cx-browser-proof.localhost'
const clientId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const elementRedirect = 'http://localhost:22911/?no_universal_links=true'

function run(command, args) {
  try {
    return execFileSync(command, args, { cwd: here, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: 120000 })
  } catch (error) {
    // Upstream stderr/config or request logs may carry sensitive data. Inspect privately.
    throw new Error(`proof_command_failed:${command}:${error.status ?? 'timeout'}`)
  }
}
function compose(args) { return run('docker', ['--context', 'colima', 'compose', '-p', project, '-f', join(here, 'compose.yaml'), ...args]) }
function capacity(minGiB) {
  const fs = statfsSync(runtimeExists() ? runtime : here)
  const free = fs.bavail * fs.bsize / 1024 ** 3
  if (free < minGiB) throw new Error(`proof_capacity_gate:${free.toFixed(2)}GiB:<${minGiB}GiB`)
  return Number(free.toFixed(2))
}
function runtimeExists() { return existsSync(runtime) }
function save(name, text) {
  const path = join(runtime, name)
  writeFileSync(path, text, { mode: 0o600, flag: 'wx' })
  chmodSync(path, 0o600)
}
function json(name, value) { save(name, JSON.stringify(value, null, 2) + '\n') }
function sections(yaml) {
  const selected = []
  let keep = false
  for (const line of yaml.split('\n')) {
    const top = /^([a-z_]+):/.exec(line)
    if (top) keep = ['secrets', 'passwords'].includes(top[1])
    if (keep) selected.push(line)
  }
  if (!['secrets', 'passwords'].every(key => selected.some(line => line.startsWith(`${key}:`)))) throw new Error('proof_generated_config_shape')
  return selected.join('\n') + '\n'
}
function prepare() {
  capacity(4)
  if (runtimeExists()) throw new Error('proof_already_prepared:preserve_existing_runtime')
  // Check all pins and prospective host ports before creating private state.
  for (const image of [masImage, 'docker.io/matrixdotorg/synapse:v1.161.0@sha256:6b95dd129e35e97e8032cb759e5db4a516a5f7ef6c98d34d716fea1ae239b62a', 'docker.io/library/postgres@sha256:3c5c8892d184f738f4fe282d14ddaa613a38f00f4189d2d94725ebe6f2909ddb']) {
    if (run('docker', ['--context', 'colima', 'image', 'inspect', image, '--format', '{{.Architecture}}']).trim() !== 'arm64') throw new Error('proof_image_not_arm64')
  }
  if (compose(['ps', '-a', '-q']).trim() || run('docker', ['--context', 'colima', 'volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '-q']).trim()) throw new Error('proof_project_already_exists')
  for (const port of [4317, 22908, 22909, 22911, 22980, 22981]) {
    const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 10000 })
    if (result.status === 0) throw new Error(`proof_port_busy:${port}`)
    if (result.status !== 1) throw new Error('proof_port_check_failed')
  }
  for (const part of ['', 'mas', 'synapse', 'tls']) {
    const dir = join(runtime, part)
    mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  save('mas/generated.yaml', sections(run('dev-container-run', ['--rm', '--network', 'none', '--pull', 'never', '--name', 'atum-cx-browser-config-generate', masImage, 'config', 'generate'])))
  const tls = join(runtime, 'tls')
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tls, 'ca.key'), '-out', join(tls, 'ca.pem'), '-days', '2', '-subj', '/CN=Atum disposable browser proof CA', '-addext', 'basicConstraints=critical,CA:TRUE'])
  run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tls, 'server.key'), '-out', join(tls, 'server.csr'), '-subj', '/CN=localhost'])
  save('tls/extensions', 'subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n')
  run('openssl', ['x509', '-req', '-in', join(tls, 'server.csr'), '-CA', join(tls, 'ca.pem'), '-CAkey', join(tls, 'ca.key'), '-CAcreateserial', '-out', join(tls, 'server.pem'), '-days', '2', '-sha256', '-extfile', join(tls, 'extensions')])
  for (const name of ['ca.key', 'ca.pem', 'server.key', 'server.csr', 'server.pem', 'ca.srl']) chmodSync(join(tls, name), 0o600)
  const dbPassword = randomBytes(24).toString('hex')
  const sharedSecret = randomBytes(32).toString('hex')
  const resources = ['discovery', 'human', 'oauth', 'compat', 'graphql', 'assets'].map(name => ({ name }))
  json('mas/proof.json', {
    http: { public_base: issuer, issuer, listeners: [
      { name: 'internal', resources: [...resources, { name: 'health' }], binds: [{ address: '0.0.0.0:8080' }] },
      { name: 'public', resources, binds: [{ address: '0.0.0.0:8443' }], tls: { certificate_file: '/tls/server.pem', key_file: '/tls/server.key' } }
    ] },
    database: { uri: `postgresql://mas:${dbPassword}@postgres/mas?sslmode=disable` },
    matrix: { kind: 'synapse', homeserver: serverName, secret: sharedSecret, endpoint: 'http://synapse:8008/' },
    clients: [{ client_id: clientId, client_auth_method: 'none', redirect_uris: ['http://localhost:4317/callback'] }],
    account: { password_registration_enabled: true, password_registration_email_required: false },
    email: { from: `proof@${serverName}`, transport: 'blackhole' },
    experimental: { access_token_ttl: 90 }
  })
  json('synapse/homeserver.yaml', {
    server_name: serverName, public_baseurl: server + '/', report_stats: false,
    pid_file: '/data/homeserver.pid',
    listeners: [8008, 8448].map(port => ({ port, tls: port === 8448, type: 'http', x_forwarded: false, bind_addresses: ['0.0.0.0'], resources: [{ names: ['client'], compress: false }] })),
    tls_certificate_path: '/tls/server.pem', tls_private_key_path: '/tls/server.key',
    database: { name: 'sqlite3', args: { database: '/data/homeserver.db' } },
    media_store_path: '/data/media', signing_key_path: '/data/signing.key',
    macaroon_secret_key: randomBytes(32).toString('hex'), form_secret: randomBytes(32).toString('hex'),
    trusted_key_servers: [], suppress_key_server_warning: true, federation_domain_whitelist: [],
    matrix_authentication_service: { enabled: true, endpoint: 'http://mas:8080/', secret: sharedSecret },
    rc_message: { per_second: 50, burst_count: 200 }
  })
  save('synapse/signing.key', `ed25519 a_cxbrowser ${randomBytes(32).toString('base64').replace(/=+$/, '')}\n`)
  save('database-password', dbPassword)
  json('owner.json', { project, issuer, server, serverName, clientId, source: run('git', ['rev-parse', 'HEAD']).trim() })
  console.log('Prepared owned private runtime; no service or account started.')
}
function check() {
  if (!existsSync(join(runtime, 'owner.json'))) throw new Error('proof_not_prepared')
  run('dev-container-run', ['--rm', '--network', 'none', '--pull', 'never', '--name', 'atum-cx-browser-config-check', '--user', `${process.getuid()}:${process.getgid()}`, '-v', `${join(runtime, 'mas')}:/config:ro`, '-v', `${join(runtime, 'tls')}:/tls:ro`, masImage, 'config', 'check', '--config', '/config/generated.yaml', '--config', '/config/proof.json'])
  compose(['config', '--quiet'])
  console.log('Real MAS config check and Compose validation passed; no service started.')
}
function owned() {
  if (!runtimeExists() || lstatSync(runtime).isSymbolicLink()) throw new Error('proof_runtime_not_owned_directory')
  const value = JSON.parse(readFileSync(join(runtime, 'owner.json'), 'utf8'))
  if (value.project !== project || value.issuer !== issuer || value.server !== server) throw new Error('proof_owner_mismatch')
  const ids = compose(['ps', '-a', '-q']).trim().split(/\s+/).filter(Boolean)
  for (const id of ids) {
    const [container] = JSON.parse(run('docker', ['--context', 'colima', 'inspect', id]))
    const labels = container.Config.Labels
    if (labels['com.docker.compose.project.working_dir'] !== here || labels['com.docker.compose.project.config_files'] !== join(here, 'compose.yaml')) throw new Error('proof_container_owner_mismatch')
  }
}
switch (process.argv[2]) {
  case 'prepare': prepare(); break
  case 'check': check(); break
  case 'up': owned(); capacity(4); check(); compose(['up', '-d', '--pull', 'never']); console.log('Owned services started. Readiness/acceptance still require proof.'); capacity(2); break
  case 'status': owned(); console.log(compose(['ps', '-a'])); break
  case 'spki': {
    owned()
    const cert = new X509Certificate(readFileSync(join(runtime, 'tls/server.pem')))
    console.log(createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64'))
    break
  }
  case 'domain': {
    owned()
    const configPath = join(runtime, 'mas/proof.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const domainId = '01ARZ3NDEKTSV4RRFFQ69G5FAX'
    if (config.clients.some(client => client.client_id === domainId)) throw new Error('proof_domain_already_registered')
    config.clients.push({ client_id: domainId, client_auth_method: 'none', redirect_uris: ['http://localhost:4317/callback'] })
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
    check()
    compose(['up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', 'mas'])
    console.log('Registered only the second disposable public domain client; existing proof keys/database preserved.')
    break
  }
  case 'element': {
    owned()
    const configPath = join(runtime, 'mas/proof.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const elementId = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
    if (config.clients.some(client => client.client_id === elementId)) throw new Error('proof_element_already_registered')
    config.clients.push({ client_id: elementId, client_auth_method: 'none', redirect_uris: [elementRedirect] })
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
    const stockConfig = {
      default_server_config: { 'm.homeserver': { base_url: server, server_name: serverName } },
      disable_custom_urls: true, disable_guests: true, enable_client_well_known_lookups: false,
      oidc_static_clients: { [issuer]: { client_id: elementId } },
      default_device_display_name: 'Disposable stock Element proof',
      integrations_ui_url: null, integrations_rest_url: null, integrations_widgets_urls: [],
      room_directory: { servers: [] }, default_federate: false,
      element_call: { disable: true }, bug_report_endpoint_url: null,
      show_labs_settings: false, default_theme: 'light'
    }
    save('element/config.json', JSON.stringify(stockConfig, null, 2) + '\n')
    check()
    compose(['up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', 'mas'])
    console.log('Registered only the disposable stock Element public client and recreated only owned MAS; signing/TLS/database state preserved.')
    break
  }
  case 'element-redirect': {
    owned()
    const configPath = join(runtime, 'mas/proof.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const client = config.clients.find(item => item.client_id === '01ARZ3NDEKTSV4RRFFQ69G5FAW')
    if (!client || client.client_auth_method !== 'none') throw new Error('proof_element_not_registered')
    client.redirect_uris = [elementRedirect]
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
    check()
    compose(['up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', 'mas'])
    console.log('Corrected only the stock Element exact redirect; existing proof keys/database preserved.')
    break
  }
  case 'down': owned(); compose(['down', '--volumes']); console.log('Removed only owned proof containers/network/database volume; private files preserved.'); break
  case 'clean': {
    owned()
    if (compose(['ps', '-a', '-q']).trim()) throw new Error('proof_services_not_removed')
    rmSync(runtime, { recursive: true, force: false })
    console.log('Deleted only this owned disposable runtime, including ephemeral keys/accounts. Not recoverable.');
    break
  }
  default: throw new Error('Usage: node proof/stack.mjs prepare|check|up|status|spki|element|element-redirect|down|clean')
}
