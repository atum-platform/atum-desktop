import assert from 'node:assert/strict'
/** Manual macOS acceptance: npx tsx scripts/word-link-native-proof.ts.
 * Uses production Word adapters/controller and two disposable DOCX documents.
 * Native Word frames/text are real; the Atum frame is an in-memory test window.
 * Leaves user documents untouched; closes and removes its own temporary files.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWordMacAdapter, WORD_AUTOMATION_SCRIPT } from '../electron/word-companion-mac.ts'
import { WordCompanionController } from '../electron/word-companion.ts'
import { createWordLiveMacAdapter } from '../electron/word-live-mac.ts'

function jxa(body: string, args: string[] = []) {
  return JSON.parse(
    execFileSync(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', WORD_AUTOMATION_SCRIPT + '\nfunction run(argv) { ' + body + ' }', '--', ...args],
      { encoding: 'utf8', timeout: 30000 }
    ).trim()
  )
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'atum-link-proof-'))
  const paths = ['Link-proof-A', 'Link-proof-B'].map(name => join(dir, name + '.docx'))
  const wasRunning = jxa('return JSON.stringify({running:wordIsRunning()})').running
  const adapter = createWordMacAdapter({ log: line => process.stdout.write(line + '\n') })
  const requests = new Map<string, unknown>()
  let controller: WordCompanionController | undefined

  try {
    for (let i = 0; i < 2; i++) {
      const txt = join(dir, 'source' + i + '.txt')
      writeFileSync(txt, 'Saved proof ' + (i ? 'B' : 'A') + '\n')
      execFileSync('/usr/bin/textutil', ['-convert', 'docx', '-output', paths[i], txt])
    }

    process.stdout.write('Opening temporary DOCX A\n')
    const a = await adapter.open(paths[0])
    process.stdout.write('Opening temporary DOCX B\n')
    await adapter.open(paths[1])
    process.stdout.write('Opened both\n')
    jxa(
      "const word=wordApplication(); const doc=findDocument(word,argv[0]); doc.textObject.content='UNSAVED_A_NATIVE_PROOF\\r'; return JSON.stringify({active:documentPath(word.activeDocument)})",
      [paths[0]]
    )

    const before = jxa(
      'const w=wordApplication(); return JSON.stringify({active:documentPath(w.activeDocument),windows:nativeWordWindows()})'
    )

    assert.equal(before.active, paths[1])

    const area = jxa(
      'const s=$.NSScreen.mainScreen;const f=s.frame,v=s.visibleFrame;return JSON.stringify({x:v.origin.x,y:f.size.height-v.origin.y-v.size.height,width:v.size.width,height:v.size.height})'
    )

    process.stdout.write('Using native work area ' + JSON.stringify(area) + '\n')
    const frame = { x: 10, y: 50, width: 1200, height: 800 }
    let currentFrame = { ...frame }
    let minimum = [760, 640]
    let layoutCalls = 0
    controller = new WordCompanionController({
      window: () => ({
        isDestroyed: () => false,
        isFullScreen: () => false,
        isMaximized: () => false,
        getNormalBounds: () => ({ ...currentFrame }),
        getBounds: () => ({ ...currentFrame }),
        getMinimumSize: () => minimum,
        setMinimumSize: (w, h) => {
          minimum = [w, h]
        },
        unmaximize: () => {},
        maximize: () => {},
        setBounds: b => {
          currentFrame = { ...b }
          layoutCalls++
        },
        show: () => {}
      }),
      authority: () => 'proof',
      authorizePath: p => String(p),
      word: adapter,
      live: createWordLiveMacAdapter(),
      resolveRequest: async ref => requests.get(ref.request_id) ?? null,
      workArea: () => area,
      ended: () => {}
    })
    process.stdout.write('Binding background A\n')
    const binding = await controller.bind('proof', { requestId: randomUUID(), path: paths[0] })
    process.stdout.write('Capturing bound A\n')
    const captured = await controller.capture('proof', binding.id)
    assert.equal(captured.text.trim(), 'UNSAVED_A_NATIVE_PROOF')
    assert.equal(captured.saved, false)
    assert.equal(captured.selection, undefined)
    assert.equal(layoutCalls, 0)

    const after = jxa(
      'const w=wordApplication(); return JSON.stringify({active:documentPath(w.activeDocument),windows:nativeWordWindows()})'
    )

    assert.equal(after.active, paths[1])
    assert.deepEqual(after.windows, before.windows)
    process.stdout.write(
      'PASS inactive DOCX binding captures unsaved A; B remains active; no foreign selection or geometry changes\n'
    )
    const layout = await controller.showBeside('proof', binding.id)
    assert.notEqual(layout.id, binding.id)
    assert.equal((await controller.capture('proof', binding.id)).text.trim(), 'UNSAVED_A_NATIVE_PROOF')
    await controller.end('proof', layout.id)
    assert.deepEqual(currentFrame, frame)
    assert.equal((await controller.capture('proof', binding.id)).text.trim(), 'UNSAVED_A_NATIVE_PROOF')
    const restored = await adapter.bind!(paths[0])
    assert.deepEqual(restored.bounds, a.bounds)
    process.stdout.write('PASS arrangement uses distinct identity; ending restores geometry and retains live binding\n')
    await controller.bringToFront('proof', binding.id)
    const request = { profile: 'default', request_id: randomUUID(), session_id: 'proof-session', turn_id: 'proof-turn' }
    requests.set(request.request_id, { ...request, action: 'read', durable_session_id: 'proof-chat', expires_at: Date.now() / 1000 + 60 })
    const read = await controller.execute('proof', binding.id, request)
    const edit = { ...request, request_id: randomUUID() }
    requests.set(edit.request_id, { ...edit, action: 'replace_text', durable_session_id: 'proof-chat', expires_at: Date.now() / 1000 + 60,
      revision: read.revision, find: 'UNSAVED_A', replacement: 'EDITED_A' })
    const edited = await controller.execute('proof', binding.id, edit)
    assert.equal(edited.applied, true)
    assert.equal(edited.saved, false)
    assert.equal(edited.text.trim(), 'EDITED_A_NATIVE_PROOF')
    await assert.rejects(() => controller!.execute('proof', binding.id, edit), /WORD_REQUEST_ALREADY_USED/)
    const stale = { ...edit, request_id: randomUUID() }
    requests.set(stale.request_id, { ...requests.get(edit.request_id) as Record<string, unknown>, ...stale })
    await assert.rejects(() => controller!.execute('proof', binding.id, stale), /WORD_CONTENT_CHANGED/)
    process.stdout.write('PASS manual binding supports explicit Bring to front plus one revision-checked unsaved edit; duplicate/stale writes rejected\n')
    jxa(
      "const d=findDocument(wordApplication(),argv[0]); d.close({saving:'no'}); return JSON.stringify({closed:true})",
      [paths[0]]
    )
    await assert.rejects(() => controller!.capture('proof', binding.id))
    process.stdout.write('PASS closing bound A rejects capture\n')
  } finally {
    await controller?.clear()

    for (const p of paths) {
      try {
        jxa(
          "if(wordIsRunning()){ const d=findDocument(wordApplication(),argv[0]); if(d)d.close({saving:'no'}) } return JSON.stringify({done:true})",
          [p]
        )
      } catch {
        /* Already closed or unavailable during test cleanup. */
      }
    }

    if (!wasRunning) {
      try {
        jxa(
          "if(wordIsRunning()){ const w=wordApplication(); if(w.documents.length===0)w.quit({saving:'no'}) } return JSON.stringify({done:true})"
        )
      } catch {
        /* Already closed or unavailable during test cleanup. */
      }
    }

    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch(error => {
  process.stderr.write(String(error) + '\n')
  process.exitCode = 1
})
