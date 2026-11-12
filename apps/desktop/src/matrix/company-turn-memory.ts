import { type MatrixCompanyTurnMemory, matrixCompanyTurnMemory } from '../../shared/matrix-company-presentation'

/**
 * This window's memory of company turns (agent-turns/1.6), one per account, for the life of the session:
 * the exact tuples seen settled or redacted stay ended (a later redaction of the settling edit never
 * brings a working line back), and the tuple of every admitted line drawn, so its redaction ends it.
 * Not rendering state: the transcripts read and extend it while they compute what they show.
 */
const memories = new Map<string, MatrixCompanyTurnMemory>()

export function companyTurnMemory(accountKey: string): MatrixCompanyTurnMemory {
  let memory = memories.get(accountKey)

  if (!memory) {
    memory = matrixCompanyTurnMemory()
    memories.set(accountKey, memory)
  }

  return memory
}
