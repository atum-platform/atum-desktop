import { readFile, writeFile } from 'node:fs/promises'

import { app } from 'electron'

import { workDesignRenderer, workDesignThumbnail } from './work-design-preview'

const [resvg, directory, format, width, height] = process.argv.slice(2)

app.setPath('userData', directory)
app.on('window-all-closed', () => {})

void app.whenReady().then(async () => {
  const source = await readFile(directory + '/source')
  if (format === 'thumbnail') {
    const dataUrl = workDesignThumbnail(source)
    if (dataUrl) {await writeFile(directory + '/thumbnail', dataUrl)}
    app.exit(0)
    return
  }
  if (format !== 'html' && format !== 'svg') {throw new Error('Unsupported fixture format')}
  const render = workDesignRenderer(resvg)
  const result = await render(source, format, Number(width), Number(height))
  if (result) {await writeFile(directory + '/raster', result)}
  app.exit(0)
}).catch(error => {
  process.stderr.write(String(error) + '\n')
  app.exit(1)
})
