import { expect, it } from "vitest";
import type { SaveEnvelope, ConflictEnvelope } from "@jotter/protocol";
import type { DraftRecord } from "../../storage/models.js";
import { OrphanRecovery } from "./orphan-recovery.js";

function draft(): DraftRecord {
  return {
    sessionId: "orphan",
    scratchpadId: "scratchpad",
    baseRevision: 0,
    content: "newer",
    dirty: true,
    updatedAt: 1,
    inFlight: { mutationId: "legacy", content: "first" },
    pending: { mutationId: "pending", content: "newer" },
  };
}

it("persists a replacement identity before replay and retains edits behind a conflict", async () => {
  const events: string[] = [];
  const saved: DraftRecord[] = [];
  const conflicts: ConflictEnvelope[] = [];
  let call = 0;
  const recovery = new OrphanRecovery(
    {
      saveDraft: async (value) => {
        events.push(`persist:${value.inFlight?.mutationId ?? value.blockedByConflictId}`);
        saved.push(value);
      },
      deleteDraft: async () => {
        throw new Error("draft must remain");
      },
      saveConflict: async (value) => {
        conflicts.push(value as ConflictEnvelope);
      },
    },
    [draft()],
    async (_hello, save) => {
      events.push(`send:${save.mutationId}`);
      if (call++ === 0)
        throw Object.assign(new Error("legacy receipt"), { name: "mutation_mismatch" });
      return {
        v: 1,
        type: "conflict",
        conflictId: "conflict",
        scratchpadId: "scratchpad",
        mutationId: save.mutationId,
        submittedContent: save.content,
        baseRevision: 0,
        serverContent: "server",
        serverRevision: 1,
        clientId: "client",
        sessionId: "orphan",
        createdAt: "2026-09-20T00:00:00Z",
      };
    },
    () => "replacement",
  );
  await recovery.run(
    "client",
    () => true,
    async () => {},
  );
  expect(events.slice(0, 3)).toEqual(["send:legacy", "persist:replacement", "send:replacement"]);
  expect(conflicts[0]?.submittedContent).toBe("first");
  expect(saved.at(-1)).toMatchObject({
    content: "newer",
    pending: { mutationId: "pending" },
    blockedByConflictId: "conflict",
    inFlight: undefined,
  });
});

it("advances a newer pending proposal only after its in-flight receipt", async () => {
  const sent: SaveEnvelope[] = [];
  let deleted = false;
  const recovery = new OrphanRecovery(
    {
      saveDraft: async () => {},
      saveConflict: async () => {},
      deleteDraft: async () => {
        deleted = true;
      },
    },
    [draft()],
    async (_hello, save) => {
      sent.push(save);
      return {
        v: 1,
        type: "ack",
        scratchpadId: "scratchpad",
        mutationId: save.mutationId,
        revision: sent.length,
        updatedAt: "2026-09-20T00:00:00Z",
      };
    },
    () => "replacement",
  );
  await recovery.run(
    "client",
    () => true,
    async () => {},
  );
  expect(sent.map(({ content, baseRevision }) => ({ content, baseRevision }))).toEqual([
    { content: "first", baseRevision: 0 },
    { content: "newer", baseRevision: 1 },
  ]);
  expect(deleted).toBe(true);
});

it("leaves drafts recoverable after a network failure", async () => {
  let persisted = false;
  const recovery = new OrphanRecovery(
    {
      saveDraft: async () => {
        persisted = true;
      },
      saveConflict: async () => {},
      deleteDraft: async () => {
        throw new Error("must not delete");
      },
    },
    [draft()],
    async () => {
      throw new Error("offline");
    },
    () => "replacement",
  );
  await expect(
    recovery.run(
      "client",
      () => true,
      async () => {},
    ),
  ).rejects.toThrow("offline");
  await expect(
    recovery.run(
      "client",
      () => true,
      async () => {},
    ),
  ).rejects.toThrow("offline");
  expect(persisted).toBe(false);
});
