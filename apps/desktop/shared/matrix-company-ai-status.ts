/** Terminal Company AI wire status copy, shared by publisher and clients. */
export type CompanyAIStatusCode = 'stopped' | 'failed' | 'unfunded' | 'couldnt_confirm'

export function companyAIStatusText(statusCode: CompanyAIStatusCode): string {
  switch (statusCode) {
    case 'unfunded': return 'Company AI needs Protons.'
    case 'stopped': return 'Stopped.'
    case 'couldnt_confirm': return "Company AI couldn't confirm this answer."
    case 'failed': return 'Company AI is unavailable.'
  }
}
