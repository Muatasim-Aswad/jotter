import { expect, it } from "vitest";
import type { StoredConflict } from "../../storage/models.js";
import { SyncMachine } from "./sync.js";
import { HttpTransportError } from "../../transport/http-transport.js";
import { ConflictResolution } from "./conflict-resolution.js";

const conflict: StoredConflict = {
  conflictId: "conflict",
  scratchpadId: "scratchpad",
  mutationId: "mutation",
  submittedContent: "local",
  baseRevision: 0,
  serverContent: "server",
  serverRevision: 1,
  sessionId: "session",
  clientId: "client",
  createdAt: "2026-09-20T00:00:00Z",
};
const state = {
  id: "scratchpad",
  content: "server",
  revision: 1,
  updatedAt: "2026-09-20T00:00:00Z",
};
function machine(): SyncMachine {
  const value = new SyncMachine("session");
  value.bootstrap(state);
  value.conflict(conflict);
  return value;
}

it("preserves the proposed resolution and refreshes the reviewed server version", async () => {
  let saved: StoredConflict | undefined;
  const workflow = new ConflictResolution(
    {
      saveConflict: async (value) => {
        saved = value;
      },
      completeResolution: async () => {
        throw new Error("must not commit");
      },
      completeOrphanResolution: async () => undefined,
    },
    {
      bootstrap: async () => ({
        scratchpad: { ...state, content: "newer server", revision: 2 },
        conflicts: [],
      }),
      resolveConflict: async () => {
        throw new Error("must not submit stale review");
      },
    },
    () => 1,
  );
  const result = await workflow.resolve(conflict, "proposed", machine());
  expect(result.kind).toBe("review");
  expect(saved).toMatchObject({
    proposedContent: "proposed",
    serverContent: "newer server",
    serverRevision: 2,
  });
});

it("retains an attempted resolution when the server is unavailable", async () => {
  let saved: StoredConflict | undefined;
  const workflow = new ConflictResolution(
    {
      saveConflict: async (value) => {
        saved = value;
      },
      completeResolution: async () => {},
      completeOrphanResolution: async () => undefined,
    },
    {
      bootstrap: async () => ({ scratchpad: state, conflicts: [] }),
      resolveConflict: async () => {
        throw new HttpTransportError("storage_unavailable", 503, "unavailable");
      },
    },
    () => 1,
  );
  const current = machine();
  expect((await workflow.resolve(conflict, "proposed", current)).kind).toBe("failed");
  expect(saved?.proposedContent).toBe("proposed");
  expect(current.snapshot.status).toBe("conflicted");
});

it("completes the active session through the durable resolution transaction", async () => {
  const committed = { ...state, content: "chosen", revision: 2 };
  let completed = false;
  const workflow = new ConflictResolution(
    {
      saveConflict: async () => {
        throw new Error("must not preserve accepted conflict");
      },
      completeResolution: async (_id, value, server) => {
        expect(value.content).toBe("chosen");
        expect(server).toEqual(committed);
        completed = true;
      },
      completeOrphanResolution: async () => undefined,
    },
    {
      bootstrap: async () => ({ scratchpad: state, conflicts: [] }),
      resolveConflict: async () => committed,
    },
    () => 1,
  );
  expect((await workflow.resolve(conflict, "chosen", machine())).kind).toBe("committed");
  expect(completed).toBe(true);
});
