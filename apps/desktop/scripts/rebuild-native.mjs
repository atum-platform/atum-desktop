// rebuild-native.mjs
import { rebuild } from '@electron/rebuild'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain } from './utils.mjs'
import packageJson from '../package.json' with { type: 'json' }
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function rebuildNodePty({ arch = process.arch } = {}) {
  await rebuild({
    buildPath: projectRoot,
    // npm workspaces hoist node-pty above apps/, which has no package.json.
    // Keep rebuild's ancestor search open through the repository root.
    projectRootPath: resolve(projectRoot, '../..'),
    electronVersion: packageJson.devDependencies.electron.replace('^', ''),
    arch,
    onlyModules: ['node-pty'],
    force: true
  })
}

if (isMain(import.meta.url)) {
  const [arch] = process.argv.slice(2)
  await rebuildNodePty({ arch })
}
