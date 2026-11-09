/**
 * The gateway's pet-hatch failures, in the user's words. The spec path sends
 * typed codes; anything else (older gateways, the image path) keeps its
 * message. Shared by the content's banner and the overlay's footer.
 */
export function petGenErrorCopy(
  code: number | null,
  message: string | null,
  copy: { errorUnsupportedAnimal: string; errorTimeout: string; errorUnreachable: string; errorNoPet: string; errorBadInput: string; errorBilling: string; genericError: string }
): string {
  switch (code) {
    case 4405:
      return copy.errorUnsupportedAnimal
    case 5032:
      return copy.errorTimeout
    case 5033:
      return copy.errorUnreachable
    case 4402:
      return copy.errorBilling
    case 5034:
      return copy.errorNoPet
    case 4004:
      return copy.errorBadInput
    default:
      return message || copy.genericError
  }
}
