import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { ArrowBackUp, Blockquote, Bold, Code, FileText, Italic, List, ListNumbers, Search, Strikethrough } from '@/lib/icons'
import type { WorkspaceTextFileLease } from '@/lib/workspace-text-file-lease'

import { resolveDocumentTheme } from '../../shared/atum-office/document-theme'
import { DocumentCommandBar } from '../app/chat/document/document-command-bar'
import type { DocumentEditorController, DocumentSelection, RichDocumentCommand, RichDocumentEditorApi } from '../app/chat/document/document-editor-controller'
import { DocumentNavigation, documentWordCount } from '../app/chat/document/document-navigation'
import { isRecoveryUnavailable, persistDocumentSnapshot } from '../app/chat/document/document-persistence'
import { DocumentStatusBar } from '../app/chat/document/document-status-bar'
import { RichDocumentEditor } from '../app/chat/document/rich-document-editor'

import type { MatrixDocumentDetachPrepare } from './text-document-actions'

export interface MatrixTextDocumentPaneProps {
  name: string
  lease: WorkspaceTextFileLease
  /** False while this account/device/room is temporarily offline. The opaque
   * lease stays mounted, but no editor or native I/O operation may start. */
  enabled?: boolean
  /** Matrix keeps this pane mounted while this promise acknowledges the latest draft. */
  onDetachReady?: (prepare: MatrixDocumentDetachPrepare | null) => void
}

interface RecoveryDraft {
  draftRevision: string
  text: string
}

interface DiskSnapshot {
  revision: string
  text: string
}

interface HistoryState {
  entries: string[]
  index: number
}

const AUTOSAVE_DELAY_MS = 80

function enqueueSerialized<T>(
  tailRef: MutableRefObject<Promise<unknown> | null>,
  work: () => Promise<T>
): Promise<T> {
  const previous = tailRef.current
  // Start an idle operation now, rather than in a microtask. A keystroke that
  // is immediately followed by a close therefore has already asked the
  // private recovery journal to retain its immutable snapshot.
  const task = previous ? previous.then(work, work) : work()
  const tail = task.then(() => undefined, () => undefined)

  tailRef.current = tail
  void tail.finally(() => {
    if (tailRef.current === tail) { tailRef.current = null }
  })

  return task
}

function isRichTextName(name: string): boolean {
  return /\.(?:md|markdown)$/iu.test(name)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isWriteConflict(error: unknown): boolean {
  return /(?:WORKSPACE_CONFLICT|DOCUMENT_RECOVERY_CONFLICT|CAPABILITY_REVOKED|SCOPE_(?:ESCAPE|STALE)|ACCOUNT_STALE)/u.test(errorMessage(error))
}

/**
 * Matrix's renderer-side rich-text projection. The opaque lease retains its
 * authority in main; this pane owns only canonical text, projection history,
 * and the acknowledgement rules around immutable persistence snapshots.
 */
export function MatrixTextDocumentPane({ name, lease, enabled = true, onDetachReady }: MatrixTextDocumentPaneProps) {
  const { t } = useI18n()
  const richEditorApiRef = useRef<RichDocumentEditorApi | null>(null)
  const aliveRef = useRef(true)
  const enabledRef = useRef(enabled)
  const wasEnabledRef = useRef(enabled)
  const leaseGenerationRef = useRef(0)
  const sourceRef = useRef('')
  const dirtyRef = useRef(false)
  const diskRef = useRef<DiskSnapshot | null>(null)
  const historyRef = useRef<HistoryState>({ entries: [''], index: 0 })
  const selectionRef = useRef<DocumentSelection>({ from: 0, to: 0 })
  const journalRevisionRef = useRef<string | null>(null)
  const savingRef = useRef(false)
  const detachInProgressRef = useRef(false)
  const autosavePausedRef = useRef(false)
  const localChangesDiscardedRef = useRef(false)
  const saveQueuedRef = useRef(false)
  const persistenceTailRef = useRef<Promise<unknown> | null>(null)
  const checkpointRecoveryRef = useRef<(text: string, editorRevision: string) => void>(() => undefined)
  const checkpointErrorRef = useRef<Error | null>(null)
  const checkpointVersionRef = useRef(0)
  const latestCheckpointRef = useRef<Promise<void>>(Promise.resolve())

  const [source, setSource] = useState('')
  const [ready, setReady] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [editorGeneration, setEditorGeneration] = useState(0)
  const [mode, setMode] = useState<'rich' | 'source'>(() => isRichTextName(name) ? 'rich' : 'source')
  const [richEligible, setRichEligible] = useState(true)
  const [navigation, setNavigation] = useState<'find' | 'outline' | null>(null)
  const [navigationFocusRequest, setNavigationFocusRequest] = useState(0)
  const [composing, setComposing] = useState(false)
  const [recoveryDraft, setRecoveryDraft] = useState<RecoveryDraft | null>(null)
  const [recoveryUnavailable, setRecoveryUnavailable] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [detaching, setDetaching] = useState(false)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [saveTick, setSaveTick] = useState(0)
  const [loadTick, setLoadTick] = useState(0)

  enabledRef.current = enabled

  const publishSource = useCallback((next: string, selection = selectionRef.current, history = true) => {
    if (detachInProgressRef.current) { return false }

    sourceRef.current = next
    dirtyRef.current = true
    selectionRef.current = selection

    if (history) {
      const previous = historyRef.current
      historyRef.current = {
        entries: [...previous.entries.slice(0, previous.index + 1), next],
        index: previous.index + 1
      }
      setHistoryVersion(version => version + 1)
    }

    setSource(next)
    setDirty(true)
    setSaveError(null)
    autosavePausedRef.current = false
    localChangesDiscardedRef.current = false
    richEditorApiRef.current?.syncSource(next, selection)
    checkpointRecoveryRef.current(next, String(historyRef.current.index))

    return true
  }, [])

  const controller = useMemo<DocumentEditorController>(() => ({
    commit: request => {
      const current = sourceRef.current
      const { from, to, insert } = request.patch

      if (request.expectedSource !== current || from < 0 || to < from || to > current.length) {
        return false
      }

      return publishSource(`${current.slice(0, from)}${insert}${current.slice(to)}`, request.selection)
    },
    getSource: () => sourceRef.current,
    redo: () => {
      const history = historyRef.current

      if (history.index >= history.entries.length - 1) { return false }
      history.index += 1
      if (!publishSource(history.entries[history.index] ?? '', selectionRef.current, false)) { return false }
      setHistoryVersion(version => version + 1)

      return true
    },
    select: selection => { selectionRef.current = selection },
    undo: () => {
      const history = historyRef.current

      if (history.index <= 0) { return false }
      history.index -= 1
      if (!publishSource(history.entries[history.index] ?? '', selectionRef.current, false)) { return false }
      setHistoryVersion(version => version + 1)

      return true
    }
  }), [publishSource])

  const richMode = isRichTextName(name) && mode === 'rich' && richEligible
  const operationBlocked = !enabled || !ready || conflict || Boolean(recoveryDraft) || detaching

  const applySnapshot = useCallback((snapshot: DiskSnapshot) => {
    diskRef.current = snapshot
    sourceRef.current = snapshot.text
    dirtyRef.current = false
    selectionRef.current = { from: 0, to: 0 }
    historyRef.current = { entries: [snapshot.text], index: 0 }
    setSource(snapshot.text)
    setDirty(false)
    setHistoryVersion(version => version + 1)
    setEditorGeneration(version => version + 1)
  }, [])

  useEffect(() => {
    aliveRef.current = true
    const generation = ++leaseGenerationRef.current
    setReady(false)
    setDirty(false)
    setSaving(false)
    setDetaching(false)
    setConflict(false)
    setSaveError(null)
    setRecoveryDraft(null)
    setRecoveryUnavailable(false)
    setMode(isRichTextName(name) ? 'rich' : 'source')
    // Do not let an old room's blocked journal tail or late failure delay or
    // poison the newly scoped lease. Old work still sees its generation fence.
    persistenceTailRef.current = null
    dirtyRef.current = false
    detachInProgressRef.current = false
    autosavePausedRef.current = false
    localChangesDiscardedRef.current = false
    checkpointErrorRef.current = null
    checkpointVersionRef.current += 1
    latestCheckpointRef.current = Promise.resolve()

    const current = () => aliveRef.current && enabledRef.current && leaseGenerationRef.current === generation

    const load = async () => {
      if (!enabledRef.current) { return }

      try {
        const snapshot = await lease.read()

        if (!current()) { return }
        applySnapshot(snapshot)
        setReady(true)

        if (!lease.recovery) { return }
        const recovered = await lease.recovery.read()

        if (!current() || recovered.outcome !== 'present') { return }
        journalRevisionRef.current = recovered.record.draftRevision
        setRecoveryDraft({ draftRevision: recovered.record.draftRevision, text: recovered.record.text })
      } catch (error) {
        if (current()) { setSaveError(errorMessage(error)) }
      }
    }

    void load()

    return () => {
      leaseGenerationRef.current = generation + 1
    }
  }, [applySnapshot, lease, loadTick, name])

  useEffect(() => () => { aliveRef.current = false }, [])

  useEffect(() => {
    if (!ready || !enabled) { return }
    const generation = leaseGenerationRef.current
    const current = () => aliveRef.current && enabledRef.current && leaseGenerationRef.current === generation

    return lease.watch(revision => {
      if (!current() || diskRef.current?.revision === revision) { return }
      void lease.read().then(next => {
        if (!current() || diskRef.current?.revision === next.revision) { return }

        if (sourceRef.current !== diskRef.current?.text) {
          setConflict(true)

          return
        }

        applySnapshot(next)
      }).catch(() => { if (current()) { setConflict(true) } })
    })
  }, [applySnapshot, enabled, lease, ready])

  useEffect(() => {
    const reconnected = enabled && !wasEnabledRef.current
    wasEnabledRef.current = enabled

    if (!reconnected) { return }
    if (!ready || !diskRef.current) {
      setLoadTick(tick => tick + 1)

      return
    }
    autosavePausedRef.current = false
    checkpointErrorRef.current = null
    setSaveError(error => error === 'MATRIX_TEXT_DOCUMENT_OFFLINE' ? null : error)

    if (dirtyRef.current) {
      checkpointRecoveryRef.current(sourceRef.current, String(historyRef.current.index))
      setSaveTick(tick => tick + 1)

      return
    }

    const generation = leaseGenerationRef.current
    void lease.read().then(snapshot => {
      if (!aliveRef.current || !enabledRef.current || leaseGenerationRef.current !== generation) { return }
      if (diskRef.current?.revision === snapshot.revision) { return }
      applySnapshot(snapshot)
    }).catch(error => {
      if (aliveRef.current && enabledRef.current && leaseGenerationRef.current === generation) {
        setSaveError(errorMessage(error))
      }
    })
  }, [applySnapshot, enabled, lease, ready])

  const checkpointRecovery = useCallback((text: string, editorRevision: string) => {
    const version = ++checkpointVersionRef.current

    if (!lease.recovery || !diskRef.current) {
      checkpointErrorRef.current = new Error('DOCUMENT_RECOVERY_UNAVAILABLE')
      latestCheckpointRef.current = Promise.resolve()

      return
    }

    const generation = leaseGenerationRef.current

    const checkpoint = enqueueSerialized(persistenceTailRef, async () => {
      if (!aliveRef.current || !enabledRef.current || leaseGenerationRef.current !== generation || !lease.recovery || !diskRef.current) {
        if (!enabledRef.current) { throw new Error('MATRIX_TEXT_DOCUMENT_OFFLINE') }
        throw new Error('CAPABILITY_REVOKED')
      }

      const journal = await lease.recovery.write({
        text,
        editorRevision,
        baseRevision: diskRef.current.revision,
        expectedDraftRevision: journalRevisionRef.current
      })

      if (!aliveRef.current || leaseGenerationRef.current !== generation) {
        throw new Error('CAPABILITY_REVOKED')
      }

      if (journal.outcome !== 'saved') {
        throw new Error('DOCUMENT_RECOVERY_CONFLICT')
      }

      journalRevisionRef.current = journal.record.draftRevision
    })

    latestCheckpointRef.current = checkpoint.then(
      () => {
        if (checkpointVersionRef.current === version) { checkpointErrorRef.current = null }
      },
      error => {
        if (checkpointVersionRef.current !== version) { return }
        const failure = error instanceof Error ? error : new Error(errorMessage(error))

        checkpointErrorRef.current = failure

        if (aliveRef.current && leaseGenerationRef.current === generation) {
          if (isRecoveryUnavailable(failure)) { setRecoveryUnavailable(true) }
          else if (errorMessage(failure) === 'MATRIX_TEXT_DOCUMENT_OFFLINE') { setSaveError(errorMessage(failure)) }
          else { setConflict(true) }
        }
      }
    )
  }, [lease])

  checkpointRecoveryRef.current = checkpointRecovery

  const saveCurrent = useCallback(async (explicit = false) => {
    if (
      savingRef.current || detachInProgressRef.current || !enabled || !ready || !dirty || recoveryDraft || conflict ||
      (autosavePausedRef.current && !explicit) || !diskRef.current
    ) { return }
    const generation = leaseGenerationRef.current
    const snapshot = diskRef.current
    const text = sourceRef.current
    savingRef.current = true
    setSaving(true)

    try {
      const result = await enqueueSerialized(persistenceTailRef, async () => {
        if (!aliveRef.current || !enabledRef.current || leaseGenerationRef.current !== generation) {
          if (!enabledRef.current) { throw new Error('MATRIX_TEXT_DOCUMENT_OFFLINE') }
          return null
        }

        const persisted = await persistDocumentSnapshot(
          lease,
          {
            text,
            baseRevision: snapshot.revision,
            editorRevision: String(historyRef.current.index),
            expectedDraftRevision: journalRevisionRef.current
          },
          revision => {
            if (aliveRef.current && enabledRef.current && leaseGenerationRef.current === generation) {
              journalRevisionRef.current = revision
            }
          },
          () => {
            if (aliveRef.current && enabledRef.current && leaseGenerationRef.current === generation) {
              setRecoveryUnavailable(true)
            }
          }
        )

        // The discard is part of the same queue as journal writes. A later
        // edit therefore observes the completed discard (or its new draft),
        // rather than racing an out-of-band deletion against its checkpoint.
        let recoveryCleanupFailed = false

        if (sourceRef.current === text && persisted.draftRevision && lease.recovery) {
          try {
            const discarded = await lease.recovery.discard(persisted.draftRevision)

            if (discarded.outcome === 'discarded') { journalRevisionRef.current = null }
            else { recoveryCleanupFailed = true }
          } catch {
            // The revision-CAS file write has already committed. Keep that
            // acknowledgement and warn about the stale private recovery copy
            // instead of fabricating a workspace conflict.
            recoveryCleanupFailed = true
          }
        }

        return { ...persisted, recoveryCleanupFailed }
      })

      if (!result || !aliveRef.current || leaseGenerationRef.current !== generation) { return }
      diskRef.current = { revision: result.revision, text }

      if (result.recoveryCleanupFailed) { setRecoveryUnavailable(true) }

      if (sourceRef.current !== text) {
        saveQueuedRef.current = true

        return
      }

      setDirty(false)
      dirtyRef.current = false

      if (checkpointErrorRef.current && isRecoveryUnavailable(checkpointErrorRef.current)) {
        checkpointErrorRef.current = null
      }
    } catch (error) {
      if (!aliveRef.current || leaseGenerationRef.current !== generation) { return }

      if (isWriteConflict(error)) { setConflict(true) }
      else {
        autosavePausedRef.current = true
        setSaveError(errorMessage(error))
      }
    } finally {
      if (aliveRef.current && leaseGenerationRef.current === generation) {
        savingRef.current = false
        setSaving(false)

        if (saveQueuedRef.current) {
          saveQueuedRef.current = false
          setSaveTick(tick => tick + 1)
        }
      }
    }
  }, [conflict, dirty, enabled, lease, ready, recoveryDraft])

  const prepareForDetach = useCallback(async () => {
    const generation = leaseGenerationRef.current
    const current = () => aliveRef.current && leaseGenerationRef.current === generation

    const fail = (error: unknown): never => {
      const failure = error instanceof Error ? error : new Error(errorMessage(error))

      if (current()) {
        detachInProgressRef.current = false
        setDetaching(false)
        setSaveError(errorMessage(failure))
      }
      throw failure
    }

    // Stop new input before we observe the queue. A native close or room
    // change can otherwise acknowledge a stable snapshot and lose a final
    // keystroke that lands before the component unmounts.
    detachInProgressRef.current = true
    setDetaching(true)

    if (!enabled) {
      if (!dirtyRef.current) { return }
      fail(new Error('MATRIX_TEXT_DOCUMENT_OFFLINE'))
    }

    // A first read can fail because the chosen file was moved. With no local
    // edit there is nothing to save, so this must not trap navigation.
    if (!ready || !current() || !diskRef.current) {
      if (!dirtyRef.current) { return }
      fail(new Error('CAPABILITY_REVOKED'))
    }

    // This is set only after the user explicitly accepts discarding their
    // local buffer. A foreign or stale private draft remains untouched, but
    // cannot hold a closed pane hostage.
    if (localChangesDiscardedRef.current && !dirtyRef.current) { return }

    const saveLatestViaCas = async () => {
      while (true) {
        const pending = persistenceTailRef.current

        if (pending) { await pending }

        const snapshot = diskRef.current

        if (!current() || !snapshot) {
          fail(new Error('CAPABILITY_REVOKED'))

          return
        }

        const text = sourceRef.current

        if (snapshot.text === text) {
          if (pending === persistenceTailRef.current) { return }

          continue
        }

        setSaving(true)
        let result: { revision: string } | null = null

        try {
          result = await enqueueSerialized(persistenceTailRef, async () => {
            if (!current()) { return null }

            return lease.write({ expectedRevision: snapshot.revision, text })
          })
        } catch (error) {
          fail(error)
        } finally {
          if (current()) { setSaving(false) }
        }

        if (!result || !current()) {
          fail(new Error('CAPABILITY_REVOKED'))

          return
        }

        diskRef.current = { revision: result.revision, text }

        if (sourceRef.current === text) {
          dirtyRef.current = false
          setDirty(false)

          return
        }
      }
    }

    if (lease.recovery) {
      // A new edit updates this ref synchronously. Loop until the tail we
      // observed is still current, so the caller gets the newest checkpoint.
      while (true) {
        const checkpoint = latestCheckpointRef.current
        try {
          await checkpoint
        } catch {
          // The failure is classified below after no newer checkpoint exists.
        }

        if (checkpoint === latestCheckpointRef.current) { break }
      }

      if (!current()) { fail(new Error('CAPABILITY_REVOKED')) }

      if (checkpointErrorRef.current) {
        if (isRecoveryUnavailable(checkpointErrorRef.current)) {
          // Recovery is optional durability. The file write is still guarded
          // by its observed revision, so acknowledge the newest source with
          // CAS instead of blocking the user forever on a failed journal.
          await saveLatestViaCas()
          checkpointErrorRef.current = null

          return
        }

        fail(checkpointErrorRef.current)
      }

      return
    }

    // Plain text has no recovery representation. Its close barrier must
    // acknowledge the current bytes through the existing revision-CAS write.
    await saveLatestViaCas()
  }, [enabled, lease, ready])

  const registeredDetachPrepare = useMemo<MatrixDocumentDetachPrepare>(() => {
    const prepare = async () => prepareForDetach()
    prepare.resumeAfterActionFailure = () => {
      // `text-document-actions` calls this only while this exact registration
      // remains active. The local fence still protects a pane that was
      // unmounted or replaced between the action failure and this callback.
      if (!aliveRef.current) { return }
      detachInProgressRef.current = false
      setDetaching(false)
      setSaveError('MATRIX_TEXT_DOCUMENT_ACTION_FAILED')
    }

    return prepare
  }, [prepareForDetach])

  useEffect(() => {
    if (!onDetachReady) { return }
    onDetachReady(registeredDetachPrepare)

    return () => onDetachReady(null)
  }, [onDetachReady, registeredDetachPrepare])

  useEffect(() => {
    if (!enabled || !ready || !dirty || saving || recoveryDraft || conflict || detaching || autosavePausedRef.current) { return }
    const timeout = window.setTimeout(() => { void saveCurrent() }, AUTOSAVE_DELAY_MS)

    return () => window.clearTimeout(timeout)
  }, [conflict, detaching, dirty, enabled, ready, recoveryDraft, saveCurrent, saveTick, saving, source])

  const runRich = (command: RichDocumentCommand, value?: number | string) => {
    if (!operationBlocked && richMode) { richEditorApiRef.current?.command(command, value) }
  }

  const openNavigation = (next: 'find' | 'outline') => {
    if (!richMode) {
      setMode('source')

      return
    }

    setNavigation(next)
    setNavigationFocusRequest(request => request + 1)
  }

  const recover = () => {
    if (!recoveryDraft) { return }
    journalRevisionRef.current = recoveryDraft.draftRevision
    setRecoveryDraft(null)
    setConflict(false)
    publishSource(recoveryDraft.text, { from: 0, to: 0 })
    setEditorGeneration(version => version + 1)
  }

  const discardRecovery = async () => {
    if (!recoveryDraft || !lease.recovery) { return }
    const generation = leaseGenerationRef.current

    try {
      const result = await enqueueSerialized(persistenceTailRef, () => lease.recovery!.discard(recoveryDraft.draftRevision))

      if (!aliveRef.current || leaseGenerationRef.current !== generation) { return }

      if (result.outcome === 'discarded') {
        journalRevisionRef.current = null
        setRecoveryDraft(null)
      } else {
        setConflict(true)
      }
    } catch (error) {
      if (aliveRef.current && leaseGenerationRef.current === generation) { setSaveError(errorMessage(error)) }
    }
  }

  const discardLocalChangesAndReload = async () => {
    if (!window.confirm(t.document.discardLocalChangesConfirm)) { return }
    const generation = leaseGenerationRef.current

    try {
      const snapshot = await enqueueSerialized(persistenceTailRef, async () => {
        const expectedDraftRevision = journalRevisionRef.current

        if (lease.recovery && expectedDraftRevision) {
          const discarded = await lease.recovery.discard(expectedDraftRevision)

          if (discarded.outcome !== 'discarded') { throw new Error('DOCUMENT_RECOVERY_CONFLICT') }
          journalRevisionRef.current = null
        }

        return lease.read()
      })

      if (!aliveRef.current || leaseGenerationRef.current !== generation) { return }
      applySnapshot(snapshot)
      setConflict(false)
      setSaveError(null)
      setRecoveryUnavailable(false)
      checkpointErrorRef.current = null
      autosavePausedRef.current = false
    } catch (error) {
      if (aliveRef.current && leaseGenerationRef.current === generation) { setSaveError(errorMessage(error)) }
    }
  }

  const discardLocalChangesAndClose = async () => {
    if (!window.confirm(t.document.discardLocalChangesConfirm)) { return }
    const generation = leaseGenerationRef.current
    const expectedDraftRevision = journalRevisionRef.current

    if (lease.recovery && expectedDraftRevision) {
      try {
        const discarded = await enqueueSerialized(persistenceTailRef, () => lease.recovery!.discard(expectedDraftRevision))

        if (!aliveRef.current || leaseGenerationRef.current !== generation) { return }
        if (discarded.outcome === 'discarded') { journalRevisionRef.current = null }
        else {
          // Do not erase a record that no longer belongs to this buffer. It
          // remains available for an explicit recovery decision next time.
          journalRevisionRef.current = discarded.record?.draftRevision ?? null
          setSaveError('DOCUMENT_RECOVERY_CONFLICT')
        }
      } catch (error) {
        if (!aliveRef.current || leaseGenerationRef.current !== generation) { return }
        // Closing after an explicit local discard must not delete or pretend
        // to resolve a journal whose ownership we could not prove.
        setSaveError(errorMessage(error))
      }
    }

    if (!aliveRef.current || leaseGenerationRef.current !== generation) { return }
    sourceRef.current = diskRef.current?.text ?? ''
    dirtyRef.current = false
    localChangesDiscardedRef.current = true
    setSource(sourceRef.current)
    setDirty(false)
    setConflict(false)
    setRecoveryDraft(null)
    checkpointErrorRef.current = null
    autosavePausedRef.current = false
  }

  const history = historyRef.current

  const status = conflict
    ? t.document.recoveryConflict
    : saving
      ? t.common.saving
      : dirty
        ? t.preview.unsavedChanges
        : ready
          ? t.document.saved
          : t.preview.loading
  const offlineWithEdits = !enabled && dirty
  const discardableSaveFailure = dirty && Boolean(saveError) && !conflict && !offlineWithEdits

  const retryWhenReady = () => {
    autosavePausedRef.current = false
    setSaveError(null)
    setSaveTick(tick => tick + 1)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-transparent" data-local-keybinds="mod+f">
      <DocumentCommandBar
        commands={{
          write: [
            { id: 'undo', label: t.document.undo, icon: <ArrowBackUp />, disabled: operationBlocked || history.index === 0, run: () => controller.undo() },
            { id: 'redo', label: t.document.redo, icon: <ArrowBackUp className="-scale-x-100" />, disabled: operationBlocked || history.index >= history.entries.length - 1, run: () => controller.redo() },
            { id: 'bold', label: t.preview.toolbarStrong, icon: <Bold />, disabled: !richMode, run: () => runRich('bold') },
            { id: 'italic', label: t.preview.toolbarEmphasis, icon: <Italic />, disabled: !richMode, run: () => runRich('italic') },
            { id: 'strike', label: t.preview.toolbarStrikethrough, icon: <Strikethrough />, disabled: !richMode, run: () => runRich('strike') },
            { id: 'bullet', label: t.preview.toolbarList, icon: <List />, disabled: !richMode, run: () => runRich('bullet') },
            { id: 'numbered', label: t.preview.toolbarOrderedList, icon: <ListNumbers />, disabled: !richMode, run: () => runRich('numbered') },
            { id: 'quote', label: t.preview.toolbarQuote, icon: <Blockquote />, disabled: !richMode, run: () => runRich('quote') }
          ],
          insert: [
            { id: 'code', label: t.preview.toolbarCode, icon: <Code />, disabled: !richMode, run: () => runRich('code') },
            { id: 'table', label: t.preview.toolbarTable, icon: <FileText />, disabled: !richMode, run: () => runRich('table') }
          ],
          page: [],
          view: [
            { id: 'rich', label: t.document.richEditor, icon: <FileText />, disabled: !isRichTextName(name), pressed: mode === 'rich', run: () => setMode('rich') },
            { id: 'source', label: t.document.sourceAdvanced, icon: <Code />, pressed: mode === 'source', run: () => setMode('source') },
            { id: 'outline', label: t.document.outline, icon: <List />, disabled: !richMode, run: () => openNavigation('outline') },
            { id: 'find', label: t.document.findReplace, icon: <Search />, disabled: !richMode, run: () => openNavigation('find') }
          ]
        }}
        disabled={operationBlocked}
        documentMenu={<span />}
        heading={0}
        labels={{ toolbar: t.document.toolbar, write: t.document.write, insert: t.document.insert, page: t.document.page, view: t.document.view, more: t.document.more, style: t.document.style }}
        onHeading={level => runRich('heading', level)}
        status={status}
        styles={[{ value: 0, label: t.document.normal }, ...[1, 2, 3, 4, 5, 6].map(value => ({ value, label: `${t.document.heading} ${value}` }))]}
      />
      {recoveryDraft && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-(--atum-line) px-3 py-2 text-xs" role="status">
          <span>{t.document.recoveryAvailable}</span>
          <Button onClick={recover} size="xs" variant="ghost">{t.document.recover}</Button>
          <Button onClick={() => void discardRecovery()} size="xs" variant="ghost">{t.document.discardRecovery}</Button>
        </div>
      )}
      {(conflict || saveError || recoveryUnavailable || offlineWithEdits) && (
        <div className="shrink-0 border-b border-(--atum-line) px-3 py-2 text-xs" role="status">
          {offlineWithEdits
            ? t.document.offlineEdits
            : conflict ? t.document.recoveryConflict : recoveryUnavailable ? t.document.recoveryUnavailable : t.document.saveFailed}
          {conflict && (
            <>
              <Button className="ml-2" onClick={() => void discardLocalChangesAndReload()} size="xs" variant="ghost">
                {t.document.discardLocalChangesAndReload}
              </Button>
              <Button className="ml-2" onClick={() => void discardLocalChangesAndClose()} size="xs" variant="ghost">
                {t.document.discardLocalChangesAndClose}
              </Button>
            </>
          )}
          {discardableSaveFailure && (
            <Button className="ml-2" onClick={() => void discardLocalChangesAndClose()} size="xs" variant="ghost">
              {t.document.discardLocalChangesAndClose}
            </Button>
          )}
          {offlineWithEdits && (
            <>
              <Button className="ml-2" onClick={() => setSaveError(null)} size="xs" variant="ghost">
                {t.document.keepEdits}
              </Button>
              <Button className="ml-2" onClick={retryWhenReady} size="xs" variant="ghost">
                {t.common.retry}
              </Button>
              <Button className="ml-2" onClick={() => void discardLocalChangesAndClose()} size="xs" variant="ghost">
                {t.document.discardLocalChangesAndClose}
              </Button>
            </>
          )}
        </div>
      )}
      {navigation && richMode && richEditorApiRef.current && (
        <DocumentNavigation
          api={richEditorApiRef.current}
          composing={composing}
          disabled={operationBlocked}
          editorKey={`${editorGeneration}:${mode}`}
          focusRequest={navigationFocusRequest}
          onClose={() => setNavigation(null)}
          onFocusEditor={() => richEditorApiRef.current?.focus()}
          outline={navigation === 'outline'}
          text={source}
        />
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {!ready ? null : richMode ? (
          <RichDocumentEditor
            apiRef={richEditorApiRef}
            controller={controller}
            enabled={!operationBlocked}
            initialValue={source}
            key={editorGeneration}
            labels={{ editor: t.document.richEditor, refused: t.document.richEditRefused }}
            onCompositionChange={setComposing}
            onEligibility={eligible => {
              setRichEligible(eligible)

              if (!eligible) { setMode('source') }
            }}
            onSave={() => void saveCurrent(true)}
            theme={resolveDocumentTheme(null)}
            zoom={zoom}
          />
        ) : (
          <textarea
            aria-label={t.document.sourceAdvanced}
            className="h-full w-full resize-none bg-transparent p-4 font-mono text-sm outline-none"
            disabled={operationBlocked}
            onChange={event => publishSource(event.target.value, { from: event.target.selectionStart, to: event.target.selectionEnd })}
            value={source}
          />
        )}
      </div>
      <DocumentStatusBar
        fitWidthLabel={t.document.fitWidth}
        onZoom={setZoom}
        status={status}
        wordCountLabel={t.document.words(documentWordCount(source))}
        zoom={zoom}
        zoomLabel={t.document.zoom}
      />
    </div>
  )
}
