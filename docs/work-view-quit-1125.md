# Work view quit crash

2026-11-25. Atum can show a main-process JavaScript error dialog on quit when
Electron destroys the Work view. The dialog requires manual dismissal.

Electron can clear the view's `webContents` property before dispatching its
`destroyed` event. Work's handler calls placement to detach the view, and
placement reads `isDestroyed()` through the cleared property. Capture the
WebContents during creation and let detachment run without consulting the
renderer window or its zoom. Late placement and focus requests skip the
destroyed contents. Hermes Pages, app sign-in, embedded apps, and PDF
previews also tolerate cleared contents in their teardown paths.

The Work regression reproduces the exception before the fix with both a
live and a destroyed host window. After the fix, each case verifies that
the view never reattaches and the session policy listener is removed. The
focused desktop suite passed 182 tests. An isolated Electron 44.10.1 smoke
run called `app.quit()` during a Work view load and confirmed that the
contents were destroyed and subsequent placement and focus were safe.
Electron typechecking and desktop lint completed successfully.
