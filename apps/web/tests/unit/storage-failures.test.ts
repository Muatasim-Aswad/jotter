import { describe, expect, it, vi } from "vitest";
import { StorageUnavailableError, storageLifecycle } from "../../src/storage/database.js";

describe("storage failure contract", () => {
  it("keeps quota errors content-free and actionable", () => {
    const cause = new DOMException("implementation detail", "QuotaExceededError");
    const error = new StorageUnavailableError(
      "The latest edit could not be saved on this device.",
      { cause },
    );
    expect(error.message).toBe("The latest edit could not be saved on this device.");
    expect(error.message).not.toContain("implementation detail");
  });

  it("allows blocked-upgrade and terminated handlers to be invoked independently", () => {
    const blocked = vi.fn();
    const close = vi.fn();
    const terminated = vi.fn();
    const lifecycle = storageLifecycle({ blocked, terminated }, close);
    lifecycle.blocked();
    lifecycle.blocking();
    lifecycle.terminated();
    expect(blocked).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    expect(terminated).toHaveBeenCalledOnce();
  });
});
