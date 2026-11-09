import type { ChildProcess } from 'node:child_process'

/** Only children we spawned, never process-name matching. A detached POSIX
 * group is retired when its leader exits, so helpers cannot escape shutdown. */
export class OwnedBackgroundChildren {
  private readonly children = new Map<ChildProcess, boolean>()
  private ending = false

  track<T extends ChildProcess>(child: T, detached = false): T {
    if (!child.pid) {
      return child
    }

    this.children.set(child, detached)
    child.once('exit', () => {
      if (detached) {
        this.signal(child, true, 'SIGKILL')
      }

      this.children.delete(child)
    })

    if (this.ending) {
      this.signal(child, detached, 'SIGKILL')
    }

    return child
  }

  killNow(): void {
    this.ending = true

    for (const [child, detached] of this.children) {
      this.signal(child, detached, 'SIGKILL')
    }
  }

  private signal(child: ChildProcess, detached: boolean, signal: NodeJS.Signals): void {
    try {
      if (detached && process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, signal)
      } else {
        child.kill(signal)
      }
    } catch {
      /* Already gone. */
    }
  }
}

export const ownedBackgroundChildren = new OwnedBackgroundChildren()
