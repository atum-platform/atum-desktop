// Static loopback proof host only. No OAuth proxy, callback logging, or compatibility API.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(await readFile(resolve(root, 'runtime-config.json'), 'utf8'))
const origins = [config.issuer, config.baseUrl, ...(config.domain ? [config.domain.apiBaseUrl] : [])].map(value => {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Invalid local proof origin')
  return url.origin
})
const files = new Map([
  ['/', ['dist/index.html', 'text/html; charset=utf-8']],
  ['/callback', ['dist/index.html', 'text/html; charset=utf-8']],
  ['/page.js', ['dist/page.js', 'text/javascript; charset=utf-8']],
  ['/page.css', ['dist/page.css', 'text/css; charset=utf-8']],
  ['/runtime-config.json', ['runtime-config.json', 'application/json']],
  ['/crypto/index.mjs', ['dist/crypto/index.mjs', 'text/javascript; charset=utf-8']],
  ['/crypto/pkg/matrix_sdk_crypto_wasm_bg.js', ['dist/crypto/pkg/matrix_sdk_crypto_wasm_bg.js', 'text/javascript; charset=utf-8']],
  ['/crypto/pkg/matrix_sdk_crypto_wasm_bg.wasm', ['dist/crypto/pkg/matrix_sdk_crypto_wasm_bg.wasm', 'application/wasm']]
])

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' ${origins.join(' ')}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`)
  // Fixed host defeats DNS rebinding; assets cannot escape the explicit map.
  if (request.headers.host !== 'localhost:4317' || !['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(403).end(); return }
  const path = new URL(request.url ?? '/', 'http://localhost:4317').pathname
  const entry = files.get(path)
  if (!entry) { response.writeHead(404).end(); return }
  try {
    const data = await readFile(resolve(root, entry[0]))
    response.setHeader('Content-Type', entry[1])
    response.writeHead(200).end(request.method === 'HEAD' ? undefined : data)
  } catch { response.writeHead(404).end() }
})
server.listen(4317, '127.0.0.1', () => console.log('Atum local proof: http://localhost:4317'))
