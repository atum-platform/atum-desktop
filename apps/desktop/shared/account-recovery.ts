/** Only transient hosted verification failures can retry saved sign-in. */
export function canRetryAccountRestore(code: string | null): boolean {
  return (
    code === 'hosted_session_unavailable' ||
    code === 'hosted_session_timeout' ||
    /^hosted_session_rejected:5\d\d$/u.test(code ?? '')
  )
}
