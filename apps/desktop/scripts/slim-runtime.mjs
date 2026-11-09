// Shrinks the staged Hermes runtime before it is copied into Atum.app.
//
// Why this exists: the runtime used to be a `git archive` of the WHOLE repository, so every
// installed app carried ~440 MB of tests, internal plans and session logs, the desktop app's own
// source tree, the website generator and the TypeScript packages. macOS verifies and copies every
// file of the bundle during a Squirrel/ShipIt update, so those bytes were paid for as minutes
// of "installing" on every update (owner ruling 2026-11-05/06, UPDATER-SEAMLESS).
//
// Rules for this list (see the tests in slim-runtime.test.mjs):
//   * only top-level *source* directories that no Python module or the Electron main process
//     reads at run time, each one checked by grep and by importing hermes_cli + tui_gateway.server
//     from the pruned tree;
//   * anything the packaged app reads from `<runtime>/hermes-agent/...` is listed in
//     NON_RUNTIME_KEEP and the test asserts it survives;
//   * nothing under Python's own tree is removed except Google *preview* API descriptions.
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

/** Paths (relative to the archived Hermes source root) that nothing reads at run time. */
export const NON_RUNTIME_SOURCE_PATHS = Object.freeze([
  // Test suites (191 MB): never imported by a shipped module.
  'tests',
  'tests-js',
  // Internal plans, handoffs, session logs, fixtures (79 MB).
  'docs',
  // The desktop app source, mobile exports, cloud controller... live in their own homes and are
  // compiled into app.asar / separate services. Python never imports them.
  'apps',
  'packages',
  // Docusaurus site: translations, theme, build config. Only website/docs and the model-catalog
  // seed are read (see NON_RUNTIME_KEEP).
  'website',
  // Design/marketing/eval material.
  'design-prototypes',
  'infograficos',
  'evals',
  'experiments',
  'contributors',
  '.github',
  'sqlite_leak_fix.png',
  'relatorio-issue-69678-sqlite-fd-leaks.md'
])

/**
 * Files and folders inside NON_RUNTIME_SOURCE_PATHS that ARE read at run time. They are kept and
 * every sibling is removed.
 *   apps/desktop/assets/pets        electron/matrix/pet-assets.ts (`<runtime.source>/apps/desktop/assets/pets`)
 *   website/static/api              hermes_cli/model_catalog.py seed_cache_from_checkout
 *   website/docs                    the bundled hermes-agent skill points the agent at these feature docs
 */
export const NON_RUNTIME_KEEP = Object.freeze([
  'apps/desktop/assets/pets',
  'website/static/api',
  'website/docs'
])

const inside = (root, candidate) => {
  const rel = relative(root, candidate)

  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** lstat that reports a missing path as null instead of throwing; every other error is real. */
function lstatOrNull(target) {
  try {
    return lstatSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return null
    }

    throw error
  }
}

/**
 * Throws when any directory component between `root` and the parent of `target` is a symlink, or
 * when the resolved parent leaves the real `root`. The final component may itself be a symlink: it
 * is removed as a link and never traversed. Pruning must never reach a file outside the staged tree
 * through a link that an archive (or a later change to the archive) planted inside it.
 */
function assertNoSymlinkAncestors(root, target) {
  const rel = relative(root, target)
  const parts = rel.split(sep).filter(Boolean)
  let current = root

  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    const stat = lstatOrNull(current)

    if (stat === null) {
      return
    }

    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to prune through symlink ${current} (escapes the staged tree)`)
    }
  }

  const parent = lstatOrNull(current)

  if (parent !== null) {
    const realRoot = realpathSync(root)
    const realParent = realpathSync(current)

    if (realParent !== realRoot && !inside(realRoot, realParent)) {
      throw new Error(`refusing to prune ${target}: its parent resolves outside ${root}`)
    }
  }
}

/**
 * Delete `target` except the sub-paths in `keep` (all absolute); empty ancestors are not left behind.
 * Walks with lstat and never follows a symlink: a symlink is unlinked (only the link, never what it
 * points at), and a symlink that sits on the way to a kept path aborts the prune.
 */
function removeExcept(target, keep) {
  const stat = lstatOrNull(target)

  if (stat === null) {
    return
  }

  const keepsHere = keep.filter(entry => entry === target || inside(target, entry))

  if (keepsHere.length === 0) {
    if (stat.isSymbolicLink()) {
      unlinkSync(target)
    } else {
      rmSync(target, { recursive: true, force: true })
    }

    return
  }

  if (keepsHere.includes(target)) {
    return
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`refusing to traverse symlink ${target} on the way to a kept path`)
  }

  if (!stat.isDirectory()) {
    return
  }

  for (const entry of readdirSync(target)) {
    removeExcept(join(target, entry), keepsHere)
  }
}

/**
 * Remove non-runtime source from an archived Hermes tree. Returns the removed top-level paths and
 * the kept sub-paths so the manifest records exactly what was cut.
 */
export function pruneNonRuntimeSource(stagedSourceRoot, { paths = NON_RUNTIME_SOURCE_PATHS, keep = NON_RUNTIME_KEEP } = {}) {
  const sourceRoot = resolve(stagedSourceRoot)
  const keepAbs = keep.map(entry => {
    const absolute = resolve(sourceRoot, entry)

    if (!inside(sourceRoot, absolute)) {
      throw new Error(`kept runtime path escapes source root: ${entry}`)
    }

    return absolute
  })
  const removed = []

  for (const sourcePath of paths) {
    const target = resolve(sourceRoot, sourcePath)

    if (!inside(sourceRoot, target)) {
      throw new Error(`non-runtime source path escapes source root: ${sourcePath}`)
    }

    if (lstatOrNull(target) === null) {
      // A missing target can still sit behind a symlinked ancestor; check the ancestors regardless.
      assertNoSymlinkAncestors(sourceRoot, target)
      continue
    }

    assertNoSymlinkAncestors(sourceRoot, target)
    removeExcept(target, keepAbs)
    removed.push(sourcePath)
  }

  return { removed, kept: [...keep] }
}

const GOOGLE_DISCOVERY_DOCUMENTS = ['googleapiclient', 'discovery_cache', 'documents']

/** `gmail.v1.json` is kept; `aiplatform.v1beta1.json` / `compute.alpha.json` are preview-only APIs. */
export const isPreviewDiscoveryDocument = name => {
  // `<api>.<version>.json`: judge the version only, so an API that merely has "beta" in its name stays.
  const match = /^[^.]+\.(.+)\.json$/u.exec(name)

  return match !== null && /(?:alpha|beta)/u.test(match[1])
}

/**
 * google-api-python-client ships a static description of every Google API (98 MB, 580 files),
 * which `build()` reads when no network discovery is used. The 218 alpha/beta descriptions are
 * 41 MB; the GA ones (Gmail, Calendar, Drive, Sheets, People, Docs, Chat, ...) stay. A caller
 * that really wants a preview API can still pass `static_discovery=False`.
 */
export function pruneGooglePreviewDiscoveryDocuments(pythonRoot) {
  const libRoot = join(pythonRoot, 'lib')
  const libStat = lstatOrNull(libRoot)

  if (libStat === null) {
    return 0
  }

  if (!libStat.isDirectory()) {
    throw new Error(`refusing to prune through non-directory ${libRoot}`)
  }

  let removed = 0

  for (const pythonDir of readdirSync(libRoot).filter(name => /^python3\.\d+$/u.test(name))) {
    // Every component down to the documents directory must be a real directory, never a link.
    let documents = join(libRoot, pythonDir)
    let present = true

    for (const part of ['site-packages', ...GOOGLE_DISCOVERY_DOCUMENTS, null]) {
      const stat = lstatOrNull(documents)

      if (stat === null) {
        present = false
        break
      }

      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`refusing to prune through ${documents}: not a real directory`)
      }

      if (part === null) {
        break
      }

      documents = join(documents, part)
    }

    if (!present) {
      continue
    }

    for (const name of readdirSync(documents)) {
      if (!isPreviewDiscoveryDocument(name)) {
        continue
      }

      const file = join(documents, name)
      const stat = lstatOrNull(file)

      if (stat === null || stat.isDirectory()) {
        continue
      }

      // A file or a link: unlink removes just that entry and never follows it.
      unlinkSync(file)
      removed += 1
    }
  }

  return removed
}

/**
 * Isolated import probe for a staged Hermes tree. It runs the staged interpreter with `-I` (no
 * PYTHON* variables, no user site, no cwd or script directory on sys.path), from a scratch cwd
 * outside any repository, with an empty HERMES_HOME, and puts ONLY the staged source first on
 * sys.path. Every module in `inside` must then resolve beneath the staged source: if the pruned
 * tree lacks a runtime file, the import fails instead of quietly finding it in the full checkout.
 */
export const ISOLATED_IMPORT_PROBE = [
  'import importlib, json, os, platform, sys',
  '# tui_gateway.server repoints sys.stdout at stderr on import; keep the real stream for the result.',
  'out = sys.stdout',
  'source = os.path.realpath(sys.argv[1])',
  'spec = json.loads(sys.argv[2])',
  'if not sys.flags.isolated: raise SystemExit("probe must run with python -I")',
  'sys.path.insert(0, source)',
  'loaded = {name: importlib.import_module(name) for name in spec["inside"] + spec["other"]}',
  'def origin(module):',
  '    path = getattr(module, "__file__", None) or (list(getattr(module, "__path__", [])) or [""])[0]',
  '    return os.path.realpath(path) if path else ""',
  'stray = {name: origin(loaded[name]) for name in spec["inside"] if not origin(loaded[name]).startswith(source + os.sep)}',
  'if stray: raise SystemExit("modules resolved outside the staged tree: %s" % json.dumps(stray))',
  'server = loaded.get("tui_gateway.server")',
  'missing = [name for name in sys.argv[3:] if name not in getattr(server, "_methods", {})]',
  'if missing: raise SystemExit("staged gateway lacks setup RPCs: %s" % missing)',
  'print(json.dumps({"python": platform.python_version(), "machine": platform.machine(), "executable": os.path.realpath(sys.executable), "origins": {name: origin(loaded[name]) for name in spec["inside"]}}), file=out)'
].join('\n')

/** The one place the probe command line is built, so the staging step and the tests cannot drift. */
export function isolatedProbeCommand({ python, sourceRoot, inside: insideModules, other = [], methods = [], home }) {
  return {
    command: python,
    args: ['-I', '-B', '-c', ISOLATED_IMPORT_PROBE, sourceRoot, JSON.stringify({ inside: insideModules, other }), ...methods],
    // Nothing is inherited: PATH, PYTHONPATH, PYTHONHOME, PYTHONSTARTUP and VIRTUAL_ENV stay out.
    env: { HERMES_HOME: home, HERMES_TEST_ISOLATION: '1', PYTHON_DOTENV_DISABLED: '1', PYTHONDONTWRITEBYTECODE: '1' }
  }
}

/**
 * Run the isolated probe against `sourceRoot`. Returns the probe's JSON (python version, real
 * executable path and the real file each `inside` module resolved to) after re-checking, on the JS
 * side too, that every origin lies in the staged tree and the executable in `expectedPythonRoot`.
 */
export function runIsolatedImportProbe({ python, sourceRoot, expectedPythonRoot, spawn = spawnSync, ...rest }) {
  const scratch = mkdtempSync(join(tmpdir(), 'atum-probe-'))
  const home = join(scratch, 'hermes-home')
  const cwd = join(scratch, 'cwd')

  mkdirSync(home)
  mkdirSync(cwd)

  try {
    const { command, args, env } = isolatedProbeCommand({ python, sourceRoot, home, ...rest })
    const result = spawn(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })

    if (result.error) {
      throw new Error(`staged runtime probe could not start: ${result.error.message}`)
    }

    if (result.status !== 0) {
      throw new Error(
        `staged runtime probe failed with exit ${result.status}:\n${[result.stdout, result.stderr].filter(Boolean).join('\n').trim()}`
      )
    }

    // Importing the gateway may log to stdout first; the probe's own JSON is the last line.
    const parsed = JSON.parse(String(result.stdout).trim().split('\n').at(-1))
    const realSource = realpathSync(sourceRoot)

    for (const [name, origin] of Object.entries(parsed.origins ?? {})) {
      if (!inside(realSource, origin)) {
        throw new Error(`staged runtime probe: ${name} resolved to ${origin}, outside the staged tree ${realSource}`)
      }
    }

    if (expectedPythonRoot && !inside(realpathSync(expectedPythonRoot), parsed.executable)) {
      throw new Error(`staged runtime probe ran ${parsed.executable}, not the staged interpreter under ${expectedPythonRoot}`)
    }

    return parsed
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
