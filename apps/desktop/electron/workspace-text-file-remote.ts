import type { WorkspaceTextFileRemoteTransport, WorkspaceTextFileSnapshot } from './workspace-text-file-lease'

type RequestJson = (path: string, method: string, body?: unknown) => Promise<unknown>

export function isWorkspaceTextRendererApiDenied(path: string): boolean {
  return /^\/api\/fs(?:[/?]|$)/u.test(path)
}

/** Privileged main-only adapter. Raw remote paths terminate at this boundary. */
export class WorkspaceTextFileRemoteAdapter implements WorkspaceTextFileRemoteTransport {
  constructor(private readonly request: RequestJson) {}

  async open(path: string): Promise<{ leaseId: string; displayName: string }> {
    return (await this.request('/api/fs/workspace-text-leases/open', 'POST', { path })) as {
      leaseId: string
      displayName: string
    }
  }

  async read(leaseId: string): Promise<WorkspaceTextFileSnapshot> {
    return (await this.request(this.path(leaseId), 'GET')) as WorkspaceTextFileSnapshot
  }

  async write(leaseId: string, input: { expectedRevision: string; text: string }): Promise<{ revision: string }> {
    return (await this.request(this.path(leaseId), 'PUT', input)) as { revision: string }
  }

  async preserveSibling(
    leaseId: string,
    input: { expectedRevision: string; text: string }
  ): Promise<{ displayName: string }> {
    return (await this.request(`${this.path(leaseId)}/preserve-sibling`, 'POST', input)) as {
      displayName: string
    }
  }

  async release(leaseId: string): Promise<void> {
    await this.request(this.path(leaseId), 'DELETE')
  }

  private path(leaseId: string): string {
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(leaseId)) {
      throw new Error('CAPABILITY_DENIED')
    }

    return `/api/fs/workspace-text-leases/${leaseId}`
  }
}
