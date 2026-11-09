/** Display-only data from the native-proved local agent home. IDs carry no
 * filesystem, node-detail or mutation authority. */
export interface MatrixStarmapNode {
  id: string
  label: string
  kind: 'memory' | 'skill'
  memorySource?: 'memory' | 'profile'
  timestamp: number | null
  category: string
  useCount: number
  state: string
  createdBy: string | null
  pinned: boolean
}
export interface MatrixStarmapGraph {
  nodes: MatrixStarmapNode[]
  edges: { source: string; target: string }[]
  clusters: { category: string; count: number }[]
  memory: { source: 'memory' | 'profile'; timestamp: number | null; title: string; body: string }[]
  stats: Record<string, number>
}
export interface MatrixStarmapClient {
  graph(): Promise<MatrixStarmapGraph>
}
