import type { ComponentProps } from 'react'

import { CONSENT_REGION_PROPS } from '../../../shared/gui-consent'

/** Trusted app components identify the complete answer region, including cancel/dismiss.
 * Main reads current geometry at the existing GUI authorization boundary.
 */
export function ConsentBoundary({ children }: ComponentProps<'div'>) {
  return <div {...CONSENT_REGION_PROPS} style={{ display: 'contents' }}>{children}</div>
}

/** Used by portalled primitives whose wrapper has no painted box. */
export const consentRegionProps = CONSENT_REGION_PROPS
