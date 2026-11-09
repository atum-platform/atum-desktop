import type { Clipboard, ClipboardItem as ElectronClipboardItem, NativeImage } from 'electron'

export interface ClipboardImageDependencies {
  clipboard: Pick<Clipboard, 'read' | 'write'>
  createItem(items: Record<string, Blob>): ElectronClipboardItem
}

const IMAGE_TYPES = ['image/png', 'image/jpeg'] as const

/** Electron 44 models the native clipboard after the asynchronous W3C API. */
export async function writeClipboardImage(
  image: Pick<NativeImage, 'toPNG'>,
  deps: ClipboardImageDependencies
): Promise<void> {
  const png = image.toPNG()
  const bytes = new Uint8Array(png.byteLength)
  bytes.set(png)

  await deps.clipboard.write([
    deps.createItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })
  ])
}

/** Read the first PNG/JPEG payload without exposing Electron's clipboard to a renderer. */
export async function readClipboardImage(
  deps: Pick<ClipboardImageDependencies, 'clipboard'>
): Promise<{ data: Buffer; extension: '.jpg' | '.png' } | null> {
  // Electron 44's read() and getType() can reject (no display server, an owner that advertises
  // a type it will not serve). Treat that as "no image" so callers fall through to their fallbacks.
  let items: Awaited<ReturnType<typeof deps.clipboard.read>>

  try {
    items = await deps.clipboard.read()
  } catch {
    return null
  }

  for (const mimeType of IMAGE_TYPES) {
    for (const item of items.filter(candidate => candidate.types.includes(mimeType))) {
      try {
        const blob = await item.getType(mimeType)

        return {
          data: Buffer.from(await blob.arrayBuffer()),
          extension: mimeType === 'image/png' ? '.png' : '.jpg'
        }
      } catch {
        continue
      }
    }
  }

  return null
}
