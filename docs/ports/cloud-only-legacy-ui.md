# Cloud-only desktop: hide the Mac-era UI

Assistants live in the cloud; Macs are devices they can reach. The desktop no
longer shows controls that only made sense when an assistant answered on a Mac.
Every gate is a pure function of `cloudOnly`, which defaults to
`AGENT_HOMES_CLOUD_ONLY` (`shared/agent-home-cloud-only.ts`). `MatrixApp` takes
one `cloudOnly` prop and passes it to every app-level gate, the roster,
Workplace and Settings, so tests can render the switched-off UI. No contract,
Electron reader or server changes: older desktops keep reading and writing the
same model-destination and home records.

Kept as they are: the card's Lives on and Can use Macs rows, Move to the cloud,
Mac sources, devices and pairing, the ChatGPT relay states, and the technical
identity row in Settings › Advanced.

## What changes under cloud-only

- **Assistant card, model.** One `Model` row (no heading, no Suggested badge)
  for the destination that answers now: the cloud, the current Mac for an
  assistant that has not moved yet, or this Mac when there is no placement and
  this Mac still answers (`cardModelChoice`). It opens the shared model picker
  and writes the same destination record the composer writes. With the switch
  off, the card shows one row per destination with names and the badge, as before.
- **Model picker.** Own-key (API key) routes are left out of cloud pickers. The
  connection help names only the ChatGPT and OpenCode Go plans. The change line
  says "This assistant". The unreachable branch that said "This Mac" on a cloud
  route is gone.
- **One rule for "this Mac answers".** `matrixAgentNeedsLocalSetup`
  (`shared/matrix-agent-actions.ts`) decides it everywhere: the composer's
  this-Mac mode, the Connections entry, roster setup and retry, the roster
  status line and the primary assistant's setup. A leftover `standby` role means
  nothing. A Mac that still holds the `answering` role stays a local
  assistant until it is moved.
- **Title bar and chat header.** The execution-order control, the settled cloud
  home icon and Reply settings are hidden. The home icon stays for a Mac-homed
  assistant or a move in progress. Linked documents keep their own control.
- **Out of Protons.** The secondary action reads "Use your ChatGPT or OpenCode
  plan" (the picker's `useYourPlan`) and opens Settings › Connections.
- **Settings › Advanced.** Local Hermes model setup and Repair are hidden. The
  "For developers" section and its assistant chooser appear only when some
  assistant has Mac-hosted pages and pages can open in this window. The chooser
  lists only those assistants.
- **Workplace.** Mac-hosted pages are hidden for a cloud assistant
  (`workplaceDeveloperPages`). Routines, Atum Drive and Store stay. Old direct
  links get one short sentence: the assistant lives in the cloud, so choose its
  model from its card.
- **Copy.** ChatGPT and OpenCode Go setup lines talk about all the owner's
  assistants, and none of them says the assistant runs on this Mac. The five
  locales change together.

## Phone snapshot

`cloudAtumOnly` stays exported, because the phone reads it. It now carries the
same short words as `changesCloudAssistant`. Remove it once the phone reads
`changesCloudAssistant`. Four snapshot strings change (`changesCloudAssistant`,
`cloudAtumOnly`, `connectionsHelp`, `phoneSettingsCopy.macAccessHelp`), and the
playground fixture gains the second Mac the card fixture now has.
`manifest.json` carries each file's SHA-256.

## Verification

From `apps/desktop`: `npm run typecheck`; ESLint on touched files; and
`npx vitest run src/matrix shared electron/matrix/model-destinations.test.ts`.

Built, not released.
