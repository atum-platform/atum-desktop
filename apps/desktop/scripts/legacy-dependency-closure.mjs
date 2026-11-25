// Run from repository root. No third-party graph dependency required.
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const repo = process.cwd()
const desktop = path.join(repo, 'apps/desktop')
const files = execFileSync('git', ['ls-files'], {encoding:'utf8',maxBuffer:16*1024*1024}).trim().split('\n').filter(f=>fs.existsSync(f))
const code = files.filter(f => /\.(?:[cm]?js|tsx?)$/.test(f))
const known = new Set(files)
const test = f => /(?:\.test\.|\.spec\.|(?:^|\/)e2e\/)/.test(f)
const config = ts.readConfigFile(path.join(desktop, 'tsconfig.json'), ts.sys.readFile)
const opts = ts.parseJsonConfigFileContent(config.config, ts.sys, desktop).options
opts.allowJs = true
const graph = new Map(), unresolved = [], dynamic = []
const resolve = (s, f) => {
  // Preserve concrete runtime files as well as TypeScript's declaration resolution.
  if(s.startsWith('.')) { const p=path.posix.normalize(path.posix.join(path.posix.dirname(f),s)); if(known.has(p)) return p }
  const r = ts.resolveModuleName(s, path.join(repo,f), opts, ts.sys).resolvedModule
  if (r) { const p=path.relative(repo,r.resolvedFileName); if(known.has(p)) return p }
  if(s.startsWith('.')) { const base=path.posix.normalize(path.posix.join(path.posix.dirname(f),s)); for(const p of [base,...['.ts','.tsx','.mjs','.js','.json','/index.ts','/index.tsx'].map(e=>base+e),base.replace(/\.js$/,'.ts')]) if(known.has(p)) return p }
  if(s.startsWith('.') || s.startsWith('@/')) unresolved.push({file:f,specifier:s})
}
for (const f of code) {
 const source=fs.readFileSync(f,'utf8'), ast=ts.createSourceFile(f, source, ts.ScriptTarget.Latest,true), edges=new Set()
 const add=s=>{ const r=resolve(s,f); if(r)edges.add(r) }
 const visit=n=>{
  if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) add(n.moduleSpecifier.text)
  if(ts.isCallExpression(n) && (n.expression.kind===ts.SyntaxKind.ImportKeyword || ts.isIdentifier(n.expression)&&['require','resolve'].includes(n.expression.text))) {
   if(n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) add(n.arguments[0].text)
   else dynamic.push(f+':'+source.slice(n.pos,n.end).trim().slice(0,180))
  }
  ts.forEachChild(n,visit)
 }; visit(ast); graph.set(f,[...edges])
}
const roots = new Set(code.filter(f=> f.startsWith('apps/desktop/scripts/') && !test(f)))
for(const f of code) if(f.startsWith('apps/desktop/electron/matrix/') && /(?:preload|sdk-host)\.ts$/.test(f) && !test(f)) roots.add(f)
for(const f of ['apps/desktop/electron/matrix/main.ts','apps/desktop/electron/main.ts','apps/desktop/electron/preload.ts','apps/desktop/electron/work/sidecar/preload.ts']) if(known.has(f)) roots.add(f)
for(const f of files.filter(f=>f.startsWith('apps/desktop/') && !f.slice(13).includes('/') && f.endsWith('.html'))) {
 const s=fs.readFileSync(f,'utf8'); for(const m of s.matchAll(/src=["']([^"']+)["']/g)) { const p='apps/desktop/'+m[1].replace(/^\//,''); if(known.has(p))roots.add(p) }
}
const walk=rs=>{const seen=new Set(); const visit=f=>{if(seen.has(f))return;seen.add(f);for(const d of graph.get(f)||[])visit(d)};for(const r of rs)visit(r);return seen}
const product=walk(roots)
// Keep the entire suite here: its transitive helpers guard supported behavior.
const tests=code.filter(f=>f.startsWith('apps/desktop/')&&test(f))
for(const f of tests) roots.add(f)
const required=walk(roots)
const candidates=code.filter(f=>f.startsWith('apps/desktop/electron/') && !f.startsWith('apps/desktop/electron/matrix/') && !required.has(f))
const rows=candidates.map(f=>({file:f,loc:fs.readFileSync(f,'utf8').split('\n').length-1,test:test(f)}))
const out={method:'TypeScript compiler AST + resolveModuleName plus concrete runtime files; conservative legacy default build, all desktop scripts, HTML, Matrix main/preloads and entire desktop test suite', roots:[...roots].sort(), product:[...product].sort(), required:[...required].sort(), unreachable:rows, unresolved, dynamic, graph:Object.fromEntries(graph)}
fs.writeFileSync(process.argv[2] || '/private/tmp/legacy-closure-graph.json', JSON.stringify(out,null,2)+'\n')
console.log(JSON.stringify({roots:roots.size,product:product.size,required:required.size,candidates:rows,unresolved:unresolved.length},null,2))
