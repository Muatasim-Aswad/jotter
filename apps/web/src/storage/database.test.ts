import { describe, expect, it, vi } from "vitest";
import { StorageUnavailableError, upgradeSchema } from "./database.js";

describe("IndexedDB upgrades", () => {
  it("creates every V1 store and the deterministic draft ordering index", () => {
    const createIndex = vi.fn();
    const createObjectStore = vi.fn(() => ({ createIndex }));

    upgradeSchema({ createObjectStore }, 0);

    expect(createObjectStore.mock.calls).toEqual([
      ["metadata", { keyPath: "key" }],
      ["server-cache", { keyPath: "id" }],
      ["drafts", { keyPath: "sessionId" }],
      ["conflicts", { keyPath: "conflictId" }],
      ["share-inbox", { keyPath: "id" }],
      ["ui-position", { keyPath: "id" }],
    ]);
    expect(createIndex).toHaveBeenCalledWith("by-updated-at", "updatedAt");
  });

  it("does not recreate stores for an existing schema", () => {
    const createObjectStore = vi.fn(() => ({ createIndex: vi.fn() }));
    upgradeSchema({ createObjectStore }, 1);
    expect(createObjectStore).not.toHaveBeenCalled();
  });

  it("exposes storage failures as an actionable stable error", () => {
    expect(new StorageUnavailableError("Local storage failed.")).toMatchObject({
      name: "StorageUnavailableError",
      message: "Local storage failed.",
    });
  });
});
