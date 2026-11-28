# Matrix pet visibility investigation, November 28

Both Macs ran candidate 0.20.55. The installed app archives matched and the
bundled Python reader decoded all four stock sprites on each Mac. The saved
chat selections were different joined personal assistant rooms. Both Matrix
sync stores showed a completed welcome and an answered folder prompt. Both Macs
logged the native SSH route error, including the Mac that rendered pets.

The Store's six pet offers describe the account catalog. Each agent's selected
pet is a separate account binding. Both installations had encrypted selection
cache entries. Their values could not be verified through read-only inspection.
Neither installation had a local pet display preferences file. That file stores
reply excerpt visibility and pop-out positions. Chat position is separate
renderer storage.

The chat mounts a pet only in an eligible personal agent room with a signed-in
account, pet bridge, and matching scope. The selection must resolve to a sprite.
An enabled binding needs current access and a readable asset, or a previously
verified eligible selection during a temporary outage. The default agent can
also display an owned or visiting stand-in where the catalog permits it. Roaming
off docks the pet. A hidden or covered window suspends the stage. A desktop
pop-out requires an explicit action, an eligible private room, and a valid
enabled sprite. Agent execution placement and the pet-intent playback flag are
independent of basic pet display.

`MatrixPets.run` could cancel the entire earlier read when a second reader for
the same agent superseded its optional roaming lookup. The chat clears its view
after that rejection, and its next read waits for a foreground or reconnect
event. The native queue now cancels only the older roaming lookup, preserving
the earlier read's authorized selection and sprite. The test exercises two
overlapping reads with a selected pet and checks both views. Scope changes and
invalid preference data still fail closed.

The concurrency failure is reproduced in the desktop tests. The installed
build logs stage activity after initialization, so the MacBook's missing stage
logs do not identify which upstream gate stopped it. The incident itself has
no live reproduction in this read-only investigation.
