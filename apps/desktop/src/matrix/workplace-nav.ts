import type { MatrixAgentView } from '../../shared/matrix'
import type { MatrixPageId } from '../../shared/matrix-pages'

/** The Atum places that stand in for a Hermes page in every everyday list. */
export type WorkplaceSurfaceId = 'routines' | 'drive' | 'store'

interface WorkplaceNavEntry {
  page: MatrixPageId
  /**
   * The Atum place that already does this page's job. Everyday lists show that place and leave the
   * page out; the page itself is still listed under For developers.
   */
  surface?: WorkplaceSurfaceId
}

/**
 * Every page an assistant has on this Mac, one row each, in the order For developers lists them.
 * The nav is this table and nothing else: Workplace, Settings › Advanced and the tests all read it,
 * so a page cannot be listed in one and forgotten in another.
 */
const WORKPLACE_NAV = [
  { page: 'scheduled', surface: 'routines' },
  { page: 'artifacts', surface: 'drive' },
  { page: 'skills', surface: 'store' },
  // The user-facing Connections destination is account-wide Settings. Hermes's combined
  // connection page is intentionally not listed here: its per-assistant provider and tool
  // controls remain available through Providers, Model & Memory, and MCP servers below.
  { page: 'runtime' },
  { page: 'providers' },
  { page: 'command-center' },
  { page: 'starmap' },
  { page: 'mcp' }
] as const satisfies readonly WorkplaceNavEntry[]

/** Under For developers: the assistant-scoped pages, never account Connections. */
export const WORKPLACE_DEVELOPER_PAGES: readonly MatrixPageId[] = WORKPLACE_NAV.map(entry => entry.page)

/** Mac-hosted pages are absent for a cloud assistant; its Atum places remain outside this list. */
export function workplaceDeveloperPages(
  agent: Pick<MatrixAgentView, 'answering' | 'home'> | undefined,
  cloudOnly: boolean = true
): readonly MatrixPageId[] {
  if (!cloudOnly || !agent) {
    return WORKPLACE_DEVELOPER_PAGES
  }

  const cloud = agent.home ? agent.home.lives.kind === 'cloud' : agent.answering === 'cloud'

  return cloud ? [] : WORKPLACE_DEVELOPER_PAGES
}

export interface WorkplaceSurface {
  id: WorkplaceSurfaceId
  /** The Hermes page this place replaces in everyday lists. */
  replaces: MatrixPageId
}

/** What the everyday lists show, in order: Atum's own places, never the pages they replace. */
export const WORKPLACE_SURFACES: readonly WorkplaceSurface[] = WORKPLACE_NAV.flatMap(entry =>
  'surface' in entry ? [{ id: entry.surface, replaces: entry.page }] : []
)

/** A page opened straight from elsewhere (the model picker, Settings, the Store) is listed under For developers. */
export function isDeveloperWorkplacePage(page: MatrixPageId | undefined): boolean {
  return Boolean(page && WORKPLACE_DEVELOPER_PAGES.includes(page))
}
