import { describe, expect, it } from "vitest";
import type { DraftRecord, ShareInboxRecord, StoredConflict } from "./models.js";
import {
  orderConflicts,
  orderOrphanDrafts,
  orderPendingShares,
  selectSessionId,
} from "./repository.js";

function draft(sessionId: string, updatedAt: number, dirty = true): DraftRecord {
  return {
    baseRevision: 1,
    content: sessionId,
    dirty,
    scratchpadId: "scratchpad-1",
    sessionId,
    updatedAt,
  };
}

const conflict = (conflictId: string, createdAt: string): StoredConflict => ({
  baseRevision: 1,
  clientId: "client",
  conflictId,
  createdAt,
  mutationId: `mutation-${conflictId}`,
  scratchpadId: "scratchpad",
  serverContent: "server",
  serverRevision: 2,
  sessionId: "session",
  submittedContent: "local",
});

const record = (
  id: string,
  createdAt: number,
  state: "consumed" | "pending",
): ShareInboxRecord => ({ createdAt, id, state, text: id });

describe("session recovery", () => {
  it("resumes its session-storage identity across reloads", () => {
    expect(selectSessionId("known", [draft("orphan", 20)], new Set(), () => "new")).toBe("known");
  });

  it("resumes the newest orphan and retains deterministic older candidates", () => {
    const drafts = [draft("older", 10), draft("newest-b", 20), draft("newest-a", 20)];
    expect(selectSessionId(null, drafts, new Set(), () => "new")).toBe("newest-a");
    expect(drafts).toHaveLength(3);
  });

  it("never adopts a draft owned by another live tab", () => {
    expect(selectSessionId(null, [draft("active", 20)], new Set(["active"]), () => "new")).toBe(
      "new",
    );
  });

  it("does not substitute a clean record for unsent work", () => {
    expect(
      selectSessionId(
        null,
        [draft("clean", 30, false), draft("dirty", 10)],
        new Set(),
        () => "new",
      ),
    ).toBe("dirty");
  });
});

describe("deterministic replay and conflict order", () => {
  it("replays oldest orphan first with a session-id tie break", () => {
    expect(
      orderOrphanDrafts([draft("later", 20), draft("b", 10), draft("a", 10)]).map(
        (value) => value.sessionId,
      ),
    ).toEqual(["a", "b", "later"]);
  });

  it("presents conflicts by creation time and stable identifier", () => {
    expect(
      orderConflicts([
        conflict("b", "2026-09-20T00:00:00Z"),
        conflict("c", "2026-09-19T00:00:00Z"),
        conflict("a", "2026-09-20T00:00:00Z"),
      ]).map((value) => value.conflictId),
    ).toEqual(["c", "a", "b"]);
  });
});

describe("share inbox order", () => {
  it("selects pending shares in creation and stable ID order", () => {
    expect(
      orderPendingShares([
        record("b", 2, "pending"),
        record("done", 0, "consumed"),
        record("c", 1, "pending"),
        record("a", 2, "pending"),
      ]).map((share) => share.id),
    ).toEqual(["c", "a", "b"]);
  });
});
