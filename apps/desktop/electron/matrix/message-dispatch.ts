/** Text and attachment sends run inside the native restart barrier (an attach uploads its bytes
 * before sending its event, so both phases stay inside it). The resulting event ID is handed to
 * `sent`, so a later turn can tell the owner typed that message on this Mac (0.20 plain rooms).
 * Every other SDK command runs directly. */
export function dispatchMatrixCommand<T>(
  kind: string | undefined,
  send: () => Promise<T>,
  barrier: (send: () => Promise<T>) => Promise<T>,
  sent: (result: T) => void
): Promise<T> {
  if (kind !== 'send' && kind !== 'attach') {
    return send()
  }

  return barrier(send).then(result => {
    sent(result)

    return result
  })
}
