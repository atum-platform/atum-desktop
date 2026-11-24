# Native T3 client CI lint repair

CI client failed on ten perfectionist errors in connector HTTP imports, native consent imports, connector tests, Connect endpoint test and renewal row/import ordering. Reordered imports and JSX props only; behavior unchanged. No pushes or CI reruns. Focused lint and public guard verification recorded below once completed.

Focused ESLint against all six changed files: exit 0. Initial public guard exit 1 rejected the session-logs path; moved this note to the permitted docs tree before retaining the commit. Native runtime behavior was not changed.

Public guard after explicit origin/main fetch: exit 0 at e0780c31 (6 new commits). Final note-only amendment requires the same guard before push. Temporary dependency install was removed after lint.
