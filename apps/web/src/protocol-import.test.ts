import { describe, expect, it } from "vitest";
import { decodeEnvelope } from "@jotter/protocol";

describe("protocol workspace export", () => {
  it("is consumed directly from TypeScript source", () => {
    expect(
      decodeEnvelope({
        v: 1,
        type: "save",
        scratchpadId: "scratchpad-1",
        content: "",
        baseRevision: 0,
        clientId: "client-1",
        sessionId: "session-1",
        mutationId: "mutation-1",
      }),
    ).toMatchObject({ type: "save", content: "" });
  });
});
