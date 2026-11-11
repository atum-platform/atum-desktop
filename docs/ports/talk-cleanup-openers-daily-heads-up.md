# Desktop cleanup: no canned openers, no 80% heads-up

Two removals on the desktop. No contract, server or style changes.

## Mac-run turns no longer open with a fixed line

- `MatrixTurnVoice` (`shared/matrix-turn-voice.ts`) no longer posts "On it, one
  moment." (or its Vietnamese, Japanese and Chinese equivalents) when the agent
  starts a tool before saying anything. The `acknowledge` option and the
  `matrixAcknowledgementCopy` table are gone; the cloud already ran without them.
- Unchanged: typing, the working line and its heartbeat, the agent's own remarks
  (`MatrixInterimMessages.offer`), and the scripted first-learning line, which
  still uses `MatrixInterimMessages.acknowledge` with its own words.
- The mobile design snapshot drops the table from `copy-inventory.json` and its
  array lengths from `copy-contract.json`. `manifest.json` carries the new
  SHA-256 of both files. The phone never read this table.

## The Mac no longer sends the 80% daily-limit heads-up

- The Mac's claim-and-post path for the heads-up (`electron/matrix/daily-cap-notice.ts`,
  `shared/daily-cap-notice.ts`, and its three triggers in `electron/matrix/main.ts`:
  account change, after a turn, window focus) is removed.
- The 100% daily cap still blocks: `daily_cap` and its words are unchanged.
- Notices already in a chat render exactly as before. The `daily_cap_warning`
  status code and its words stay in `shared/matrix-agent-status-copy.ts`, so the
  cloud's status notice is still recognized. The Mac's old scheduled notice
  renders from its own body. Tests in `src/matrix/message.test.ts` and
  `src/matrix/app.test.tsx` cover both.
- The cloud's own heads-up is sent by the cloud controller and is not changed here.
- The assistant card's daily-limit row still shows its state line
  ("Today's limit is nearly reached."). It is a setting's readout, not a chat notice.
