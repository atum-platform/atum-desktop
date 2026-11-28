import { createContext, type ReactNode } from 'react'

/** Playground media occupies the same DOM slot as the production guest. */
export const WorkPreviewContext = createContext<ReactNode>(null)
