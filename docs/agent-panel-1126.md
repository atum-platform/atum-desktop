# Agent panel: one place, controls back, the model that answers (2026-11-26)

Owner, testing desktop 0.20.55 (atum-desktop main 52b0d1aa3e) on Raymond's chat: "raymond doesn't switch to opus when
i click repeatedly? Also the side panel for agent looks off ... missing the controls we had earlier - the 'mute', the
device access etc.? I think consolidating it like this is not bad, but control should still exist. 'Lives on' and stuff
seem obsolete now. And if we consolidate then clicking the agent name should open this side panel instead of a popup
with identical info".

## 1. The model chip named Nguyệt Thực while Claude Opus 5.5 answered

The server held Raymond's Mac-plan selection (`matrix_model_choices.work_selection` = claude / claude-opus-5-5,
revision 2) and his replies ran on it. His agent has a D1 home, which puts `MatrixModelPicker` in home mode. In home
mode the chip name, the checked row and `isCurrent` came only from the home's stored model (managed `nguyet-thuc`);
the relay selection read by #139 was ignored there. Clicking Opus wrote a selection that was already saved and the
chip never moved.

Fix (`src/matrix/model-picker.tsx`):

- A selected Mac plan is current on a placed cloud home too (`isRelayCurrent`); a plan pick in flight wins first and an
  Atum/home pick in flight holds the plan back.
- The chip and the card's Model row name it. The card row takes the name through `trigger` as a function
  (`assistant-card/model-destinations-row.tsx`), so the row and the chip never disagree. Shelf and external labels
  keep their "Provider · Model" form.
- Picking Nguyệt Thực while a plan answers is a real switch. On a placed home it goes through the home model write
  (`owner.home.model-choice.write`); for a cloud destination that bumps `matrix_model_choices.revision`, and
  migration 0536's `work_selection_clear` trigger clears the plan selection server-side (verified in atum-platform
  `0302_agent_placement_connection_platform.sql` and `0536_work_relay_contract.sql`). The picker forgets the
  selection it holds at once rather than naming the plan until a re-read. The non-home Atum write no longer no-ops on
  the stored alias while a plan answers.

## 2. The agent's side panel lost its controls

What happened: up to 0.20.54 an assistant chat's side panel opened on the agent desk tab (`agent-desk.tsx`, plan
2026-11-13 rounds 3–4: Now, Files, and Controls with Model, Pause, Notifications, Your devices, and More). Kit step 5
(ddf9eaf0, 2026-11-25, `assistant-info-panel.tsx`) made the panel's default content the assistant card instead. The
desk stayed only as the pinned tab of the workbench, which shows only once a document or a tab is open. So the panel
the owner saw had no notifications, devices or Pause. The same card also opened as a separate sheet from the agent's
name.

Now the panel is the agent's one place: its card with the desk's live parts folded in.

| Row | Decision | Why |
| --- | --- | --- |
| Now (working / waiting, the ask, Stop, the device in use) | restored, top of the panel, only while it works or waits | Live: native progress, prompts and Stop. Idle shows nothing. |
| Notifications | restored | This chat's own mute (Matrix push rules). |
| Your devices | restored as one row with a popover: each Mac's state, Allow, Stop while in use | Live reach-down for cloud agents. Hidden when it has no Mac. |
| Pause | restored | Native cron pause through the host. Shown only once the host reads its schedule. |
| Files (sent here, its own files) | restored, after the rows | Live. Hidden when empty. |
| Model, Pet, Skills, Background follow-ups, Routines, persona, handle, Delete | kept | Already on the card. |
| Lives on | dropped for cloud assistants | Cloud-only (`AGENT_HOMES_CLOUD_ONLY`): "The cloud" says nothing. It is kept only for an assistant still on a Mac, moving, or with a home issue, where it is the way to the cloud. Its "Can use" Mac list is the Your devices row now. |
| More / "All settings" (desk) | not carried over | The panel is the card; there is nothing further to open. |

One card place: opening an assistant's card (its name or face in the chat header, roster Info, Settings › its row,
the composer's "Add routines") opens this panel beside its own chat. If another chat is open, that chat is selected
first. The sheet remains only for an assistant with no chat of its own yet (`AssistantCardHost inPanel`).

Not changed: the workbench's pinned desk tab (shown while documents or tabs are open) is left as is to keep this
diff off #136/#141's files. Folding that tab into the same body is a possible follow-up.

## Verification

Commands and results are in the commit body and the coordinator handoff. Screenshots:
`~/.atum/operations/evidence/agent-panel-1126/`.
