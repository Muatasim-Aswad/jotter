import { describe, expect, it } from "vitest";
import { MAX_CONTENT_BYTES } from "@jotter/protocol";
import type { ShareInboxRecord } from "../storage/models.js";
import { appendShare } from "./append.js";

function share(values: Partial<ShareInboxRecord>): ShareInboxRecord {
  return { createdAt: 1, id: "share-1", state: "pending", ...values };
}

describe("share append", () => {
  it("preserves title-text-URL order and removes only exact duplicates", () => {
    expect(
      appendShare(
        "existing",
        share({ text: "Title", title: "Title", url: "https://example.test" }),
      ),
    ).toEqual({
      appended: true,
      content: "existing\n\nTitle\nhttps://example.test",
      overLimit: false,
    });
  });

  it("preserves distinct whitespace and normalizes line endings", () => {
    expect(appendShare("", share({ text: "value ", title: "value", url: "a\r\nb" })).content).toBe(
      "value\nvalue \na\nb",
    );
  });

  it("leaves an over-limit share unapplied", () => {
    const content = "a".repeat(MAX_CONTENT_BYTES - 1);
    expect(appendShare(content, share({ text: "x" }))).toEqual({
      appended: false,
      content,
      overLimit: true,
    });
  });
});
