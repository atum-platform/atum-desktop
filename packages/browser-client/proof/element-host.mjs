// Serve only the hash-verified stock Element archive, quietly on one loopback port.
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '.runtime/element')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2' }
createServer(async (request, response) => {
  try {
    if (request.headers.host !== 'localhost:22911' || !['GET', 'HEAD'].includes(request.method)) throw new Error('request_refused')
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost:22911').pathname)
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
    if (!path.startsWith(root + sep)) throw new Error('file_refused')
    const actual = await realpath(path)
    if (!actual.startsWith(root + sep) || !(await stat(actual)).isFile()) throw new Error('file_refused')
    response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    if (request.method === 'HEAD') response.end()
    else createReadStream(actual).on('error', () => response.destroy()).pipe(response)
  } catch { response.writeHead(404); response.end() }
}).listen(22911, '127.0.0.1', () => console.log('Stock Element disposable proof host: http://localhost:22911'))
