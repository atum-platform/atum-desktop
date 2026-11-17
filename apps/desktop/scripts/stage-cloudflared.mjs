import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Apache-2.0, official release archives. Provisioned only by packaging.
const VERSION = '2026.11.0'
const DIGESTS = {
  arm64: '8c2f90277ef06a6080bb40b964d33f09f1188102f8798f2e344174b6cf41accf',
  x64: '8a59d51120cebbe902f0a8d6e1b7a7fd4f9a5bb4dcb3e0f05872483e75e7db6b'
}
export default async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch]
  if (!arch) throw new Error('cloudflared_unsupported_arch')
  const root = context.packager.appDir
  // Build the fixed stdio adapter with the target's SDK; no runtime interpreter needed.
  execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-target',
    `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx13.0`,
    new URL('../native/chatgpt-relay.swift', import.meta.url).pathname,
    '-o', path.join(root, 'atum-chatgpt-relay')])
  await chmod(path.join(root, 'atum-chatgpt-relay'), 0o755)
  const stage = await mkdtemp(path.join(root, '.cloudflared-'))
  try {
    const response = await fetch(
      `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-darwin-${arch === 'x64' ? 'amd64' : 'arm64'}.tgz`
    )
    if (!response.ok) throw new Error('cloudflared_download_failed')
    const archive = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(archive).digest('hex') !== DIGESTS[arch])
      throw new Error('cloudflared_digest_failed')
    await writeFile(path.join(stage, 'helper.tgz'), archive)
    execFileSync('/usr/bin/tar', ['-xzf', path.join(stage, 'helper.tgz'), '-C', stage, 'cloudflared'])
    const binary = path.join(stage, 'cloudflared')
    // Mach-O CPU type guards the selected target before signing/packing.
    const bytes = await readFile(binary)
    if (bytes.readUInt32LE(4) !== (arch === 'arm64' ? 0x100000c : 0x1000007)) throw new Error('cloudflared_wrong_arch')
    await chmod(binary, 0o755)
    await mkdir(root, { recursive: true })
    await rename(binary, path.join(root, 'cloudflared'))
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
