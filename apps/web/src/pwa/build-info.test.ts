import { describe, expect, it } from "vitest";
import { buildLabel, runningBuild, seenRevisionKey, takeUpdateNotice } from "./build-info.js";

function memoryStorage(seen: string | null) {
  const values = new Map<string, string>(seen === null ? [] : [[seenRevisionKey, seen]]);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("buildLabel", () => {
  it("pairs the version with the short revision, or shows the revision alone", () => {
    const build = { version: "1.0.0", revision: "a1b2c3d4e5", committedAt: null, builtAt: "" };
    expect(buildLabel(build)).toBe("1.0.0 · a1b2c3d");
    expect(buildLabel({ ...build, version: null })).toBe("a1b2c3d");
  });
});

describe("takeUpdateNotice", () => {
  it("records the build silently on a first visit", () => {
    const storage = memoryStorage(null);
    expect(takeUpdateNotice(storage)).toBeNull();
    expect(storage.getItem(seenRevisionKey)).toBe(runningBuild.revision);
  });

  it("announces a new build once", () => {
    const storage = memoryStorage("an-older-revision");
    expect(takeUpdateNotice(storage)).toEqual(runningBuild);
    expect(takeUpdateNotice(storage)).toBeNull();
  });

  it("stays quiet when storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
    };
    expect(takeUpdateNotice(blocked)).toBeNull();
  });
});
