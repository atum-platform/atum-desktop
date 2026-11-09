export interface TeamSpaceSidebarEntryCounts {
  threads: number
  saved: number
  drafts: number
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function teamSpaceSidebarEntryVisibility(counts: TeamSpaceSidebarEntryCounts) {
  return {
    threads: counts.threads > 0,
    saved: counts.saved > 0,
    drafts: counts.drafts > 0
  }
}
