// Each TypeScript program gets its own process so its compiler heap is released on exit.
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const config = process.argv[2]
if (!['tsconfig.json', 'tsconfig.electron.json'].includes(config)) throw new Error('Unknown boundary check configuration')
const privateRoots = ['cloud-controller', 'cloud-sandbox'].map(name => path.join(root, 'packages', name))
const privatePath = file => privateRoots.some(dir => file === dir || file.startsWith(dir + path.sep))

const host = ts.createCompilerHost({})
for (const method of ['fileExists', 'directoryExists', 'readFile', 'getDirectories']) {
  const original = host[method]?.bind(host)
  if (original) host[method] = file => privatePath(path.resolve(file)) ? (method === 'readFile' ? undefined : method === 'getDirectories' ? [] : false) : original(file)
}
const configFile = path.join(root, 'apps/desktop', config)
const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {noEmit: true, incremental: false, composite: false}, {...ts.sys, ...host, onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')) }})
const program = ts.createProgram(parsed.fileNames, parsed.options, host)
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
const leaked = program.getSourceFiles().filter(source => privatePath(source.fileName))
if (diagnostics.length || leaked.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {getCurrentDirectory: () => root, getCanonicalFileName: f => f, getNewLine: () => '\n'}))
  throw new Error(`${config}: private-absent compilation failed; ${leaked.length} private sources`)
}
console.log(`${config}: PASS with both private server packages inaccessible (${program.getSourceFiles().length} source files, zero private sources).`)
