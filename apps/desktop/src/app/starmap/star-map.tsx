import { NodeContextMenu } from './node-context-menu'
import { StarMapCanvas, type StarMapViewProps } from './star-map-canvas'

/** Legacy desktop retains its original node edit/archive/delete authority. */
export function StarMap(props: StarMapViewProps) {
  return <StarMapCanvas {...props} NodeMenu={NodeContextMenu} />
}
