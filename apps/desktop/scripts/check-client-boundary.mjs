/** Enforce the public client closure, including tests, scripts, config and fixture reads. */
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const privateRoots = ['cloud-controller', 'cloud-sandbox'].map(name => path.join(root, 'packages', name))
const privatePath = file => privateRoots.some(dir => file === dir || file.startsWith(dir + path.sep))
const forbidden = value => /(?:^|[/\\])packages[/\\]cloud-(?:controller|sandbox)(?:[/\\]|$)/u.test(value) || /^@atum\/cloud-(?:controller|sandbox)(?:\/|$)/u.test(value)
// Resolve workspace aliases locally, without following shared dependency links into
// another checkout. Scan each used package's tests and fixture reads as well.
const workspaceRoots = ['apps', 'packages'].flatMap(parent => fs.readdirSync(path.join(root, parent)).flatMap(name => {
  const directory = path.join(root, parent, name)
  const manifest = path.join(directory, 'package.json')
  return fs.existsSync(manifest) ? [{directory, name: JSON.parse(fs.readFileSync(manifest, 'utf8')).name}] : []
}))
const pending = ['apps/desktop', 'apps/shared'].map(dir => path.join(root, dir))
const enqueue = file => {
  const workspace = workspaceRoots.find(item => file === item.directory || file.startsWith(item.directory + path.sep))
  pending.push(workspace?.directory ?? file)
}

const visited = new Set()
const failures = []
const options = {moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, resolveJsonModule: true}
while (pending.length) {
  const file = path.resolve(pending.pop())
  if (visited.has(file)) continue
  visited.add(file)
  if (privatePath(file)) { failures.push(path.relative(root, file)); continue }
  if (!fs.existsSync(file)) continue
  if (fs.statSync(file).isDirectory()) {
    for (const entry of fs.readdirSync(file)) {
      if (!['node_modules', '.git', 'build', 'dist', 'release', 'web_dist'].includes(entry)) pending.push(path.join(file, entry))
    }
    continue
  }
  if (!/\.(?:[cm]?[jt]sx?|json)$/u.test(file)) continue
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const visit = node => {
    if (ts.isStringLiteralLike(node)) {
      const value = node.text
      if (forbidden(value) || value.startsWith('.') && privatePath(path.resolve(path.dirname(file), value))) {
        failures.push(`${path.relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${value}`)
      }
      if (value.startsWith('.') && value.includes('packages/')) enqueue(path.resolve(path.dirname(file), value.split('*')[0]))
      // Follow resolved workspace imports, including package aliases and transitive dependencies.
      if (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) || ts.isCallExpression(node.parent) && (node.parent.expression.kind === ts.SyntaxKind.ImportKeyword || node.parent.expression.getText(source) === 'require')) {
        const workspace = workspaceRoots.find(item => value === item.name || value.startsWith(item.name + '/'))
        if (workspace) enqueue(workspace.directory)
        const resolved = ts.resolveModuleName(value, file, options, ts.sys).resolvedModule?.resolvedFileName
        if (resolved?.startsWith(root) && !resolved.includes('/node_modules/')) enqueue(resolved)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
if (failures.length) {
  console.error('Client boundary violation:\n' + failures.join('\n'))
  process.exit(1)
}
console.log('Client boundary passed: desktop/shared and client package import closure contain no private server references.')

// Compile with a virtual filesystem that makes private packages unreadable/nonexistent.
// No worktree directories are renamed or removed; no build artifacts are emitted.
if (process.argv.includes('--typecheck-without-controller')) {
  const host = ts.createCompilerHost({})
  for (const method of ['fileExists', 'directoryExists', 'readFile', 'getDirectories']) {
    const original = host[method]?.bind(host)
    if (original) host[method] = file => privatePath(path.resolve(file)) ? (method === 'readFile' ? undefined : method === 'getDirectories' ? [] : false) : original(file)
  }
  for (const config of ['tsconfig.json', 'tsconfig.electron.json']) {
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
  }
}
