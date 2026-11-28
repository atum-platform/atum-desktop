# Desktop Work assistant handoff

The primary Work view can send text through the managed assistant selected in
the owner's chat. Desktop validates the owner view, resolves the assistant
against the account roster, and uses the existing verified owner DM Work
request and receipt. The Work thread returned by the relay identifies the same
assistant for later submissions, including after the user changes selection.
Each submission carries its selected Work model and provider instance.

When no eligible relay is available before submission, a new draft can start as
a standalone Work session. A submitted request with an unknown outcome keeps
its draft for retry. A bound session requires its assistant connection.

For a finished S1 DOCX, Desktop resolves the result identity against the
account's Work receipt and verifies the original file in the private Work
output directory. The Mac provider receives the local reference. Signed,
enrolled provider acceptance follows runtime assembly.
