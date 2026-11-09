/** Account/session-local provenance; raw JSON can never set this bit. */
export function createPetLiveEvents<Event extends object>() {
  let live = new WeakSet<Event>()
  let loadedRoom: string | undefined

  return {
    loaded(roomId: string | null) {
      if (loadedRoom !== (roomId ?? undefined)) {
        live = new WeakSet<Event>()
      }

      loadedRoom = roomId ?? undefined
    },
    observed(event: Event, roomId: string, toStart: boolean, removed: boolean, liveEvent: boolean) {
      if (roomId === loadedRoom && !toStart && !removed && liveEvent) {
        live.add(event)
      } else {
        live.delete(event)
      }
    },
    has(event: Event, roomId: string) {
      return loadedRoom === roomId && live.has(event)
    }
  }
}
