# Chat parity mockups M1–M4: notes (2026-11-27)

These are mockups only; nothing here is built. Open `index.html`. The frames are in `png/`: desktop at 1440×900 @2x, phone at 393×852 @3x, each with `-light` and `-dark`. The live HTML is in `html/`.
Regenerate with `python3 src/gen.py && node src/render.mjs && python3 src/index.py`.

- **Authorization:** owner, 2026-11-27: "chat parity: go with Astra's recommnedations. If there's no plan yet, then opus plan and astra review, then send out to codex workers to build. As the workers build, they should compare their code to Element X as tight reference."
- **Plan:** `docs/plans/2026-11-27-chat-parity-build.md` (atum-desktop, branch `docs/chat-parity-audit`), §4 S1, S2, S4, S6–S9 and §5 M1–M4.
- **Visual base:** the desktop chrome comes from the layout-language mockups (`layout-language-1124/src/gen.py`): rail, roster panel, main card, right panel and title-bar zones A–F. The tokens are atum-desktop `packages/atum-kit/approved-0.1.css`, copied as is. The phone frames follow the public phone client: header capsule (back, name pill, more), card rows on the grouped ground, a composer pill with the field on top and +, mic and send circle below, and the capsule tab bar (`docs/evidence/native-device/*.png` in atum-mobile; `ios/App/Chat/Views/Composer.swift` in atum-mobile-client).
- **Element X:** used only as the behaviour reference (the files the plan names per slice). No assets, strings or layouts were copied. The SAS emoji names are the Matrix spec's.

## Design decisions

### M1 · Search
1. **Results replace the roster in the left panel.** This is layout rule D: "the D search finds a place". Nothing new opens. Clearing the field brings the roster back. The main card keeps showing whatever chat is open, and selecting a hit opens it there.
2. **One row per hit, as tall as a roster row:** the snippet with the match marked on the first line, sender and time on the second. Rows group under the chat's face and name, ordered by the newest hit. The plan asked for one line per hit. Two lines keep the density at roster level in a 258 px panel, so the UI is not denser than today.
3. **Source labels only for company chats** (`Atum Studio`). Writing "Personal" on every row is noise. If the person has no company, no label appears.
4. **Coverage is one quiet line at the foot:** "Searched 42 chats · 3 private chats indexed up to 12 Oct". A private hit carries a small lock after the time. There is no banner, sheet or info button. Element X discloses history limits in a separate sheet; we fold it into the line.
5. **Opening a hit draws a quiet ring around the message.** It takes the same ring as the open thread root in M2, and fades after a moment in the build.
6. **No results:** one line, one hint, and the coverage line again, so the person knows what was searched.

### M2 · Threads
1. **Entry: one icon in the message hover bar** (desktop) and one item under Reply in the long-press menu (phone). It appears only in eligible rooms (plan S4 rule), so assistant DMs look exactly as today.
2. **Summary under the root:** one capsule with up to three faces, "N replies" and the last reply time. It matches the Element X root summary, and is the only addition to the main timeline.
3. **Desktop thread = right panel,** reusing the Team Space thread panel. Its composer has the same buttons as the main one. On phone the thread is a pushed screen titled "Thread" with the group name under it.
4. **Thread list lives in the chat details** (right panel on desktop, info sheet on phone): the three latest with unread dots, then "All threads". The title bar gets no new button (layout zone C stays search · … · panel).

### M3 · Voice notes
1. **The voice-note button sits in the send slot when the composer is empty:** an ink circle with a waveform glyph. Typing turns it back into send. The dictation **mic** stays where it is, unchanged. So the two actions never look alike or sit as two mics side by side. This is the Element X pattern (empty composer → voice button), adapted to Atum's existing send circle.
2. **Tap to record, tap to stop. No press and hold.** Element X iOS uses tap; it's easier to reach and works with a trackpad. Recording turns the composer into one ledge: delete, red dot and timer, live waveform, stop.
3. **Review before send is always on:** delete, play, waveform, length, send. Cancel by delete at any point; nothing uploads until send (plan S6 acceptance 2).
4. **Bubble:** play or pause, waveform with played bars solid, time. Your own bubble uses the own-bubble colour, others the quiet fill. The phone uses the same bubble.
5. **Assistant listening:** drawn as one inline line above the review ledge, asked once per assistant, with no modal ("Allow" / "Send audio only"). The recommended default is not to ask at all. See question 2.
6. **Microphone permission** is asked by the OS on the first record only. A refusal shows one recoverable line in the ledge (not drawn; same slot as the timer).

### M4 · Trust and private chats
1. **Phone verification starts from the phone, finishes on the Mac.** It is a full screen with one line ("Open Atum on your MacBook Pro"), a spinner, and the recovery key as the only alternative. The Mac shows a dialog with the same seven emoji. Both sides follow the Element X state machine: requested → emoji → matched, mismatched or cancelled.
2. **Match:** a short toast ("iPhone confirmed"), then the person is back where they were. **Mismatch:** "Not confirmed. Nothing was shared." with Try again. A peer cancel or a timeout uses the same screen with a different line.
3. **Key setup appears only when someone first turns on Private.** It is one screen showing the key, with "Save to Passwords" first and Copy second, then done. Plain-chat users never see it (plan S8 acceptance 4).
4. **Restore after reinstall:** enter or paste the key, or confirm from the Mac. One screen.
5. **Private at creation is one row, off by default.** Turned off, the line under it says what it is. Turned on, it adds "Can't be turned off later", and assistants grey out in the people list with one reason. No dialog, no confirmation wall. The row appears only when this device has passed S7 and S8 (plan S9 acceptance 4). Until then the row isn't shown at all.

## Owner questions (each with the default we build if there's no answer)

1. **Search source labels.** Should personal chats show a "Personal" label next to company ones (the plan text), or only company chats get a label?
   **Default: only company chats get one.** It is less noise, and with no company there are no labels at all.
2. **Voice notes to assistants.** Should an assistant transcribe voice notes automatically, or ask once per assistant first (plan S6)?
   **Default: automatic, no ask.** The assistant already handles everything typed to it, and the owner rules say "default automatic, no consent walls". The inline line in `m3-d-assistant` is kept only for an assistant whose speech model is a different provider from the one already handling its chat.
3. **Where the recovery key is saved.** Should we offer "Save to Passwords" (iCloud Keychain, the system password manager) as the first action, with Copy second?
   **Default: yes, Passwords first.** It's the least effort and survives a lost phone. Copy stays available.
4. **Recording gesture.** Tap to start and tap to stop (drawn), or press and hold with slide to cancel (the WhatsApp habit)?
   **Default: tap.** It is accessible, matches Element X iOS, and works the same way on desktop.
5. **Thread summary when the root is one of your own messages.** Should it look the same, aligned right?
   **Default: same capsule, aligned under your bubble on the right.** Not drawn.

## Not drawn (existing kit covers them, or they follow directly)
Peer-cancelled and timed-out verification (same screen as mismatch, different line), microphone refused (one line in the ledge), voice note sent to a client without voice support (a file row, already in kit), and the thread unread badge on the roster row (same badge as today).

## Owner decisions (2026-11-27)
"go with defaults on the questions": Q1 company-only labels; Q2 voice transcription asked once at first use per assistant/provider; Q3 Save to Passwords first; Q4 tap to record; Q5 same thread summary right-aligned under own messages.
