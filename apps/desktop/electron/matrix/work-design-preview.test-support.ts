import { readFile, writeFile } from 'node:fs/promises'

import { app } from 'electron'

import { workDesignRenderer } from './work-design-preview'

const [resvg, directory, format, width, height] = process.argv.slice(2)

app.on('window-all-closed', () => {})

void app.whenReady().then(async () => {
  if (format !== 'html' && format !== 'svg') {throw new Error('Unsupported fixture format')}
  const render = workDesignRenderer(resvg)
  const result = await render(await readFile(directory + '/source'), format, Number(width), Number(height))
  if (result) {await writeFile(directory + '/raster', result)}
  app.exit(0)
}).catch(error => {
  process.stderr.write(String(error) + '\n')
  app.exit(1)
})
