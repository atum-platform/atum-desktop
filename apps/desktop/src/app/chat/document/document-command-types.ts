import type { ReactNode } from 'react'

export type DocumentCommandGroup = 'write' | 'insert' | 'page' | 'view'
export type DocumentViewMode = 'live' | 'rendered' | 'source' | 'diff'

export interface DocumentCommandItem {
  id: string
  label: string
  icon?: ReactNode
  pressed?: boolean
  disabled?: boolean
  run: () => void
}

export interface DocumentCommandLabels {
  toolbar: string
  write: string
  insert: string
  page: string
  view: string
  more: string
  style: string
}

export interface DocumentStyleOption {
  value: number
  label: string
}

export interface DocumentCommandBarProps {
  labels: DocumentCommandLabels
  commands: Record<DocumentCommandGroup, DocumentCommandItem[]>
  styles: DocumentStyleOption[]
  heading: number
  onHeading: (level: number) => void
  disabled?: boolean
  status: ReactNode
  documentMenu: ReactNode
  pageControls?: ReactNode
  viewControls?: ReactNode
}

export interface DocumentStatusBarProps {
  wordCountLabel: string
  zoomLabel: string
  fitWidthLabel: string
  zoom: number | 'fit'
  onZoom: (zoom: number | 'fit') => void
  status?: ReactNode
}
