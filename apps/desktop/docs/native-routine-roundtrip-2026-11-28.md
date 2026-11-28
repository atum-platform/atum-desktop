# S2 Desk and routine round trip

The [own-routines audit](https://github.com/atum-platform/atum-app/pull/1105) identified two gaps. Desk guessed Pause and Resume results until reopened, and the editor's platform endpoint could not read jobs created in the agent's native cron store.

- Desk refreshes on window focus, explicit Refresh, and successful routine controls. It displays the native pause state after Resume and surfaces the number of jobs outside its 32-row preview.
- The editor sends S2 native jobs through the enrolled host. An open form keeps its original revision through refresh so a concurrent agent edit returns a conflict. Advanced native cadences keep their exact expression when the user edits other fields.
- Existing controller-only routines keep their platform history and CRUD. Native projections of these routines retain the existing desktop UUID while addressing the native job ID on the host.

Verification covers Desk refresh and overflow, mixed global and individual pauses, native short IDs and projection IDs in Electron, and stale editor drafts. The card revamp can keep its layout and slots. The shared integration points are the schedule hook and the card control and routine data calls, plus the panel's disambiguation of advanced cadence fields.
