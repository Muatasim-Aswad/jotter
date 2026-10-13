import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeEnvelope, encodeEnvelope, ProtocolError } from "../src/index.js";

interface EnvelopeCase {
  name: string;
  error?: ProtocolError["code"];
  input: unknown;
  expected?: unknown;
}

interface SizeCase {
  name: string;
  value: string;
  repeat: number;
  valid: boolean;
}

const fixtures = JSON.parse(readFixture("envelopes.json")) as {
  valid: EnvelopeCase[];
  invalid: EnvelopeCase[];
};
const sizeCases = (JSON.parse(readFixture("content-size.json")) as { cases: SizeCase[] }).cases;

describe("shared envelope fixtures", () => {
  for (const fixture of fixtures.valid) {
    it(`accepts and serializes ${fixture.name}`, () => {
      const decoded = decodeEnvelope(fixture.input);
      expect(decoded).toEqual(fixture.expected ?? fixture.input);
      expect(JSON.parse(encodeEnvelope(decoded))).toEqual(fixture.expected ?? fixture.input);
    });
  }

  for (const fixture of fixtures.invalid) {
    it(`rejects ${fixture.name}`, () => {
      try {
        decodeEnvelope(fixture.input);
        throw new Error("fixture was accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(ProtocolError);
        expect((error as ProtocolError).code).toBe(fixture.error);
      }
    });
  }
});

describe("shared UTF-8 size fixtures", () => {
  for (const fixture of sizeCases) {
    it(fixture.name, () => {
      const input = {
        v: 1,
        type: "save",
        scratchpadId: "scratchpad-1",
        content: fixture.value.repeat(fixture.repeat),
        baseRevision: 0,
        clientId: "client-1",
        sessionId: "session-1",
        mutationId: "mutation-1",
      };
      if (fixture.valid) expect(() => decodeEnvelope(input)).not.toThrow();
      else
        expect(() => decodeEnvelope(input)).toThrowError(
          expect.objectContaining({ code: "content_too_large" }),
        );
    });
  }
});

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
}
