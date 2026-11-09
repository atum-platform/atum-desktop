import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from 'vitest'

import { MatrixDriveImport } from '../drive-import'

import { DriveWorkspaceCopies } from './workspace'

const native = process.platform === 'darwin' || process.platform === 'linux'

test.skipIf(!native).each(['working_copy', 'inactive_working_copy', 'disconnected_drive'] as const)(
  'private A2 workspace facts refuse %s before any import staging',
  async selected => {
    const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atum-private-import-')))

    try {
      const activeDrive = path.join(home, 'Atum', 'Drive')
      const oldDrive = path.join(home, 'Previous Drive')
      const tasksRoot = path.join(home, 'Atum Tasks')

      const privateFiles = {
        working_copy: path.join(tasksRoot, 'Agent', 'Task', 'report.txt'),
        inactive_working_copy: path.join(tasksRoot, 'Agent', 'Previous task', 'report.txt'),
        disconnected_drive: path.join(oldDrive, 'report.txt')
      }

      mkdirSync(activeDrive, { recursive: true })

      for (const file of Object.values(privateFiles)) {
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, 'synthetic private work')
      }

      const copies = new DriveWorkspaceCopies({
        drive: { savedRoot: () => oldDrive, manifestFor: async () => null },
        workspaceLabel: async () => null,
        tasksRoot,
        artifactsRoot: path.join(home, 'device-artifacts')
      })

      await copies.refresh()

      const facts = statSync(activeDrive)

      const python = execFileSync('python3', ['-I', '-B', '-S', '-c', 'import sys;print(sys.executable)'], {
        encoding: 'utf8'
      }).trim()

      const importer = new MatrixDriveImport({
        home,
        python,
        target: () => ({ root: activeDrive, dev: facts.dev, ino: facts.ino, ownerKey: 'synthetic-owner:1' }),
        choose: async () => [privateFiles[selected]],
        protectedRoots: () => [
          ...copies.driveRoots(),
          ...(selected === 'inactive_working_copy' ? [tasksRoot] : copies.agentWorkingRoots())
        ]
      })

      expect(await importer.importPlan()).toEqual({ state: 'refused', reason: 'protected' })
      expect(readFileSync(privateFiles[selected], 'utf8')).toBe('synthetic private work')
      expect(readdirSync(activeDrive)).toEqual([])
      expect(existsSync(path.join(home, 'Atum', '.import'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
)
