// Matrix product roots only. Tests are inventoried separately, never product roots.
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const root = path.resolve(import.meta.dirname, '../../..')
const desktop = 'apps/desktop/'
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {cwd: root, encoding:'utf8',maxBuffer:16*1024*1024}).trim().split('\n').filter(f => fs.existsSync(path.join(root,f)))
const config = ts.readConfigFile(path.join(root,desktop,'tsconfig.json'),ts.sys.readFile).config
const options = ts.parseJsonConfigFileContent(config,ts.sys,path.join(root,desktop)).options
const graph = new Map(), unresolved = []
function edges(file) {
 if(graph.has(file)) return graph.get(file)
 const found = new Set(); graph.set(file,found)
 if(!/\.(?:[cm]?[jt]sx?|html)$/.test(file)) return found
 const source = fs.readFileSync(path.join(root,file),'utf8')
 const add = value => {
  if(!value.startsWith('.') && !value.startsWith('@/')) return
  const resolved = ts.resolveModuleName(value,path.join(root,file),{...options,allowJs:true},ts.sys).resolvedModule?.resolvedFileName
  const concrete = path.resolve(root,path.dirname(file),value)
  for(const candidate of [resolved, concrete, ...['.ts','.tsx','.mjs','.cjs','.js','.json','/index.ts','/index.tsx'].map(s=>concrete+s)]) {
   if(candidate && candidate.startsWith(root+'/') && !candidate.includes('/node_modules/') && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) found.add(path.relative(root,candidate))
  }
  if(!found.size && value.startsWith('.')) unresolved.push({file,value})
 }
 if(file.endsWith('.html')) { for(const m of source.matchAll(/src=["']([^"']+)["']/g)) add(m[1].startsWith('/')? './'+m[1].slice(1):m[1]); return found }
 const ast = ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true)
 const visit = node => {
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) add(node.moduleSpecifier.text)
  if(ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast)==='require') && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) add(node.arguments[0].text)
  ts.forEachChild(node,visit)
 }; visit(ast); return found
}
const roots = files.filter(f=> f.startsWith(desktop) && (/\/scripts\//.test(f) && !/\.test\./.test(f) || /\/matrix[^/]*\.html$/.test(f)))
roots.push(...['main','ui-preload','sdk-preload','pages-preload','app-panel-preload','pet-overlay-preload'].map(n=>desktop+`electron/matrix/${n}.ts`),desktop+'electron/work/sidecar/preload.ts')
const reachable = new Set(), pending = [...roots]
while(pending.length) { const f=pending.pop(); if(reachable.has(f)||!fs.existsSync(path.join(root,f))) continue; reachable.add(f); pending.push(...edges(f)) }
// Keep source imported by surviving presentation/type declarations too. Retiring
// the legacy renderer is a separate cut; do not leave its type imports broken.
const matrixReachable = new Set(reachable)
pending.push(...files.filter(f=>f.startsWith(desktop+'src/') && !/\.test\./.test(f)))
while(pending.length) { const f=pending.pop(); if(reachable.has(f)||!fs.existsSync(path.join(root,f))) continue; reachable.add(f); pending.push(...edges(f)) }
const candidates=files.filter(f=>f.startsWith(desktop+'electron/') && !f.startsWith(desktop+'electron/matrix/') && !f.startsWith(desktop+'electron/work/') && /\.(?:ts|cjs|mjs)$/.test(f) && !/\.test\.|test-fixtures/.test(f) && !reachable.has(f))
const removed = new Set(candidates)
const obsoleteTests = files.filter(f=>f.startsWith(desktop) && /\.test\./.test(f) && [...edges(f)].some(dep=>removed.has(dep)))
const report={roots:roots.sort(),matrixReachable:[...matrixReachable].sort(),reachable:[...reachable].sort(),candidates,obsoleteTests,unresolved}
fs.writeFileSync(process.argv[2]??'matrix-closure.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({roots:roots.length,reachable:reachable.size,candidates:candidates.length}))
