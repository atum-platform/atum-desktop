/** App-owned markers only. The proposal marker also covers the independently assembled
 * confirmation-card branch before its component adopts ConsentBoundary.
 */
export const CONSENT_SELECTOR = '[data-atum-consent], [data-matrix-agent-proposal="pending"], [data-matrix-agent-proposal="failed"]'
export const CONSENT_REGION_PROPS = { 'data-atum-consent': 'true' } as const

/** Serialized into a trusted app renderer by main, with no captured state or imports. */
export function readConsentRegions(document: Document, selector: string) {
  return Array.from(document.querySelectorAll(selector))
    .flatMap(node => [node, ...Array.from(node.querySelectorAll('*'))])
    .flatMap(node => Array.from(node.getClientRects()))
    .filter(rect => rect.width > 0 && rect.height > 0)
    .map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }))
}
