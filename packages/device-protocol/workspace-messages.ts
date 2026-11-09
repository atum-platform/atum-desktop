/** Typed lifecycle companion; authority always comes from stored grants, never tool args. */
import type { ReceiptArtifact } from './messages';

export interface WorkspaceBinding {
  requestId: string;
  grantId: string;
  invocationId: string;
  connectionId: string;
  connectionEpoch: number;
  deviceServiceId: string;
  enrollmentEpoch: number;
  accountEpoch: number;
  writerEpoch: { leaseGeneration: number; leaseTokenHash: string };
}
export interface WorkspaceManifestFile {
  path: string; size: number; sha256: string; inode: number; mtimeNs: string;
  server: { resource: { storage: string; space: string; opaque: string }; etag: string } | null;
}
export interface WorkspaceManifest {
  v: 1; deviceServiceId: string; taskId: string; folder: string;
  files: WorkspaceManifestFile[]; truncated: boolean;
}
export interface WorkspaceFinalize extends WorkspaceBinding { issuedAt: number; expiresAt: number }
export interface WorkspaceResult extends WorkspaceBinding {
  manifest: WorkspaceManifest;
  artifacts: ReceiptArtifact[];
  outputs: { path: string; artifactName: string }[];
  deleted: string[];
  complete: boolean;
  resultHash: string;
  conflicts: { key: string; path: string; artifactName: string; label: string }[];
}
export interface WorkspaceConfirm extends WorkspaceBinding {
  resultHash: string; saved: boolean; confirmedConflictKeys: string[];
}
export interface WorkspaceRefused extends WorkspaceBinding {
  reason: 'unavailable' | 'stopped' | 'expired' | 'binding_mismatch' | 'quiescence_failed';
}
export interface WorkspaceMessageBodies {
  WorkspaceFinalize: WorkspaceFinalize;
  WorkspaceResult: WorkspaceResult;
  WorkspaceConfirm: WorkspaceConfirm;
  WorkspaceRefused: WorkspaceRefused;
}
