import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { SourceMap } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const BRAND = /(?<![a-z0-9_])(?:t3|hermes|nous)(?![a-z0-9_])|t3[_-]?(?:code|thread_[a-z_]+)|nousresearch|hermes_home/iu
const NON_RENDERER_OUTPUT = new Set([
  'matrix-app-panel-preload.js',
  'matrix-pages-preload.js',
  'matrix-pet-preload.js',
  'matrix-sdk-preload.js',
  'matrix-sdk.html',
  'matrix-sdk.js',
  'matrix-ui-preload.js',
  'matrix-work-preload.js'
])

export function hasLegacyBrand(value) {
  const decoded = value
    .replace(/&#(x[\da-f]+|\d+);?/gi, (entity, point) => {
      const code = /^x/i.test(point) ? Number.parseInt(point.slice(1), 16) : Number(point)
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity
    })
    .replace(/(?:%[\da-f]{2})+/gi, part => {
      try { return decodeURIComponent(part) } catch { return part }
    })

  return BRAND.test(decoded.normalize('NFKC'))
}

// Static concatenations and interpolation of literals represent one rendered value.
function staticText(node) {
  if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) return node.text
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left)
    const right = staticText(node.right)
    if (left !== undefined && right !== undefined) return left + right
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text
    for (const span of node.templateSpans) {
      const value = staticText(span.expression)
      if (value === undefined) return
      text += value + span.literal.text
    }
    return text
  }
}

export function scanRendererScript(code, sourceFor, allowlist) {
  const ast = ts.createSourceFile('renderer.js', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  const hits = []
  function visit(node) {
    const value = staticText(node)
    if (value !== undefined) {
      if (hasLegacyBrand(value)) {
        const { line, character } = ast.getLineAndCharacterOfPosition(node.getStart(ast))
        const source = sourceFor(line, character)
        // Dependency runtime strings are outside this first-party copy check.
        // Unmapped values are scanned. Only an actual mapped dependency is excluded.
        if (!source?.split('/').includes('node_modules') && !allowlist[source]?.includes(value)) {
          hits.push({ source, line: line + 1, value })
        }
      }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return hits
}

export function verifyRendererBrand(directory, root, entries, allowlist) {
  for (const entry of entries) {
    const file = join(directory, entry)
    if (!existsSync(file) || !statSync(file).isFile() || !statSync(file).size) {
      throw new Error('Missing renderer entry: ' + entry)
    }
  }

  const problems = new Set()
  for (const name of readdirSync(directory, { recursive: true })) {
    if (NON_RENDERER_OUTPUT.has(name) || !/\.(?:js|html)$/i.test(name)) continue
    const file = join(directory, name)
    const code = readFileSync(file, 'utf8')
    if (name.endsWith('.html')) {
      if (hasLegacyBrand(code)) problems.add(name + ': legacy brand in HTML')
      continue
    }

    const mapFile = file + '.map'
    const map = existsSync(mapFile) ? new SourceMap(JSON.parse(readFileSync(mapFile, 'utf8'))) : null
    const hits = scanRendererScript(code, (line, column) => {
      const source = map?.findEntry(line, column).originalSource
      if (!source) return name
      return relative(root, resolve(dirname(file), source)).replaceAll('\\', '/')
    }, allowlist)
    for (const { source, value } of hits) {
      problems.add(source + ': ' + JSON.stringify(value))
    }
  }

  if (problems.size) throw new Error('Legacy product branding in renderer:\n' + [...problems].sort().join('\n'))
}


if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const directory = resolve(process.argv[2] ?? join(root, 'dist-matrix'))
  const allowlist = JSON.parse(readFileSync(new URL('./renderer-brand-allowlist.json', import.meta.url), 'utf8'))
  verifyRendererBrand(directory, root, ['matrix.html', 'matrix-pet.html', 'pages/matrix-pages.html'], allowlist)
  console.log('Atum branding verified in all three desktop renderers.')
}
