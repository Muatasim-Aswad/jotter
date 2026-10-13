# Jotter

A private scratchpad whose edits remain available across devices and disconnections.

## Language

**Scratchpad**: The single shared text document. Avoid: note, page.

**Revision**: A committed version of the scratchpad, ordered after the preceding accepted change.

**Draft**: One editing session's local text, including changes that have not reached an acknowledged outcome.

**Mutation**: One proposed change with a stable identity, an expected base revision, and complete proposed text. Reusing its identity means retrying the same proposal.

**Receipt**: Confirmation that a particular mutation was accepted at a particular revision. It is not document history.

**Conflict**: A preserved proposal that could not replace the current revision, together with the server version needed for an explicit choice.

**Resolution**: The user's chosen text submitted against the latest reviewed server revision.

**Share inbox**: Shared text awaiting incorporation into a local draft.
