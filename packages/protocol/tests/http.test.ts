import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeHttp, MAX_CONTENT_BYTES, type HttpPayloads } from "../src/index.js";

interface Fixture {
  name: string;
  schema: keyof HttpPayloads;
  input: unknown;
}
const fixtures = JSON.parse(
  readFileSync(new URL("../fixtures/http.json", import.meta.url), "utf8"),
) as { valid: Fixture[]; invalid: Fixture[] };

describe("shared HTTP contracts", () => {
  for (const fixture of fixtures.valid) {
    it(`accepts ${fixture.name}`, () =>
      expect(() => decodeHttp(fixture.schema, fixture.input)).not.toThrow());
  }
  for (const fixture of fixtures.invalid) {
    it(`rejects ${fixture.name}`, () =>
      expect(() => decodeHttp(fixture.schema, fixture.input)).toThrow());
  }
  it("bounds normalized UTF-8 content", () => {
    expect(() =>
      decodeHttp("ResolveRequest", {
        content: "é".repeat(MAX_CONTENT_BYTES / 2 + 1),
        baseRevision: 0,
      }),
    ).toThrow();
    expect(() =>
      decodeHttp("ResolveRequest", { content: "\r\n".repeat(MAX_CONTENT_BYTES), baseRevision: 0 }),
    ).not.toThrow();
  });
});
