import { describe, expect, it } from "vitest";
import { MAX_CONTENT_BYTES } from "@jotter/protocol";
import { ContentLimitError, SyncMachine } from "./sync.js";

function readyMachine(): SyncMachine {
  const machine = new SyncMachine("session-1");
  machine.bootstrap({
    content: "server",
    id: "scratchpad-1",
    revision: 4,
    updatedAt: "2026-09-20T00:00:00Z",
  });
  return machine;
}

describe("sync state machine", () => {
  it("renews a rejected identity without losing in-flight or newer pending content", () => {
    const machine = readyMachine();
    machine.edit("in flight", () => "legacy");
    machine.beginSave();
    machine.edit("newer", () => "pending");
    expect(machine.replaceMutationIdentity("unrelated", () => "wrong")).toBe(false);
    expect(machine.replaceMutationIdentity("legacy", () => "replacement")).toBe(true);
    expect(machine.snapshot).toMatchObject({
      content: "newer",
      baseRevision: 4,
      inFlight: { content: "in flight", mutationId: "replacement" },
      pending: { content: "newer", mutationId: "pending" },
    });
    expect(
      machine.acknowledge({ mutationId: "legacy", revision: 5, updatedAt: "2026-09-20T00:00:05Z" }),
    ).toBeUndefined();
  });
  it("coalesces edits into one durable pending mutation", () => {
    const machine = readyMachine();
    let nextId = 0;
    const makeId = () => `mutation-${++nextId}`;

    machine.edit("one", makeId);
    machine.edit("two", makeId);

    expect(machine.snapshot).toMatchObject({
      content: "two",
      dirty: true,
      pending: { content: "two", mutationId: "mutation-1" },
      status: "dirty",
    });
  });

  it("keeps newer local edits pending while one mutation is in flight", () => {
    const machine = readyMachine();
    let nextId = 0;
    const makeId = () => `mutation-${++nextId}`;
    machine.edit("first", makeId);
    expect(machine.beginSave()).toEqual({ content: "first", mutationId: "mutation-1" });
    machine.edit("newer", makeId);

    const cache = machine.acknowledge({
      mutationId: "mutation-1",
      revision: 5,
      updatedAt: "2026-09-20T00:00:05Z",
    });

    expect(cache).toMatchObject({ content: "first", revision: 5 });
    expect(machine.snapshot).toMatchObject({
      baseRevision: 5,
      content: "newer",
      pending: { content: "newer", mutationId: "mutation-2" },
      status: "dirty",
    });
  });

  it("ignores acknowledgements for another mutation", () => {
    const machine = readyMachine();
    machine.edit("local", () => "mutation-1");
    machine.beginSave();
    expect(
      machine.acknowledge({
        mutationId: "other",
        revision: 5,
        updatedAt: "2026-09-20T00:00:05Z",
      }),
    ).toBeUndefined();
    expect(machine.snapshot.status).toBe("saving");
  });

  it("normalizes line endings and accepts the exact UTF-8 byte boundary", () => {
    const machine = readyMachine();
    machine.edit(`a\r\n${"é".repeat((MAX_CONTENT_BYTES - 2) / 2)}`, () => "mutation-1");
    expect(machine.snapshot.content.startsWith("a\n")).toBe(true);
  });

  it("rejects content beyond the UTF-8 byte boundary without replacing the draft", () => {
    const machine = readyMachine();
    expect(() => machine.edit("😀".repeat(MAX_CONTENT_BYTES / 4 + 1), () => "mutation-1")).toThrow(
      ContentLimitError,
    );
    expect(machine.snapshot.content).toBe("server");
  });

  it("pauses outgoing work when a conflict is preserved", () => {
    const machine = readyMachine();
    machine.edit("local", () => "mutation-1");
    machine.conflict({
      baseRevision: 4,
      clientId: "client-1",
      conflictId: "conflict-1",
      createdAt: "2026-09-20T00:00:05Z",
      mutationId: "mutation-1",
      scratchpadId: "scratchpad-1",
      serverContent: "remote",
      serverRevision: 5,
      sessionId: "session-1",
      submittedContent: "local",
    });
    expect(machine.beginSave()).toBeUndefined();
    expect(machine.snapshot.status).toBe("conflicted");
  });

  it("applies newer committed state only while clean", () => {
    const machine = readyMachine();
    expect(
      machine.applyRemote({
        content: "remote",
        id: "scratchpad-1",
        revision: 5,
        updatedAt: "2026-09-20T00:00:05Z",
      }),
    ).toMatchObject({ content: "remote", revision: 5 });
    expect(machine.snapshot.content).toBe("remote");
    machine.edit("local", () => "mutation-1");
    expect(
      machine.applyRemote({
        content: "newer remote",
        id: "scratchpad-1",
        revision: 6,
        updatedAt: "2026-09-20T00:00:06Z",
      }),
    ).toBeUndefined();
    expect(machine.snapshot.content).toBe("local");
  });

  it("keeps a newer pending edit after resolving its in-flight conflict", () => {
    const machine = readyMachine();
    machine.edit("first", () => "mutation-1");
    machine.beginSave();
    machine.edit("newer", () => "mutation-2");
    machine.conflict({
      baseRevision: 4,
      clientId: "client-1",
      conflictId: "conflict-1",
      createdAt: "2026-09-20T00:00:05Z",
      mutationId: "mutation-1",
      scratchpadId: "scratchpad-1",
      serverContent: "remote",
      serverRevision: 5,
      sessionId: "session-1",
      submittedContent: "first",
    });
    machine.resolve({
      content: "resolved",
      id: "scratchpad-1",
      revision: 6,
      updatedAt: "2026-09-20T00:00:06Z",
    });
    expect(machine.snapshot).toMatchObject({
      baseRevision: 6,
      content: "newer",
      dirty: true,
      pending: { mutationId: "mutation-2" },
      status: "dirty",
    });
  });
});
