# First learning in native cron

A trusted setup process can tag a finite job with `seed_key: first-learning`.
This uses the ordinary cron toolset and delivery authorities. During that run,
`memory` accepts only `target=user`, including batches. The restriction is scoped
to the run and cleared on exit.

The native interim callback sends up to three progress lines, each at most 180
characters, followed by a final line with the same length limit. External workers
use distinct durable delivery queue keys for progress and the final result. Other
cron jobs retain their existing presentation. This does not alter conversation
history, prompts, or toolsets in an existing conversation.

The connect-card request uses operation `first_learning` on the existing agent
routines resource. The domain authority chooses the runtime admission path.
