/** The continuity rules live in shared code so the cloud controller applies the same ones. */
export {
  canResumeConversation,
  continuityDiagnostic,
  conversationAnchor,
  conversationSeed,
  conversationWitness,
  readContinuityResult,
  validHistorySeed
} from '../../shared/matrix-continuity-seed'
