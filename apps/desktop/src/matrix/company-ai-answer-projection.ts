import type { CompanyAIAnswerProjection } from './company-desktop-adapter'

/** The company answer a Matrix event carries, if any. UI-free: shared by the renderer and the Activity model. */
export function companyAIAnswerProjection(value: unknown): CompanyAIAnswerProjection | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const candidate = value as { companyAIAnswer?: unknown; companyAI?: unknown }
  const answer = candidate.companyAIAnswer ?? candidate.companyAI

  if (!answer || typeof answer !== 'object') {
    return undefined
  }

  const projection = answer as Partial<CompanyAIAnswerProjection>

  return projection.schemaVersion === 1 &&
    typeof projection.companyId === 'string' &&
    typeof projection.channelId === 'string' &&
    Array.isArray(projection.citations) &&
    projection.coverage !== undefined
    ? (projection as CompanyAIAnswerProjection)
    : undefined
}
