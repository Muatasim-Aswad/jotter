import { describe, expect, it } from "vitest";
import { mapSelection } from "./view.js";

describe("remote caret mapping", () => {
  it("keeps a caret in an unchanged suffix attached to the same text", () => {
    expect(
      mapSelection("hello world", "hello brave world", {
        id: "editor",
        scrollTop: 12,
        selectionDirection: "none",
        selectionEnd: 11,
        selectionStart: 11,
      }),
    ).toEqual({
      id: "editor",
      scrollTop: 12,
      selectionDirection: "none",
      selectionEnd: 17,
      selectionStart: 17,
    });
  });

  it("maps a selection in replaced text to the end of the replacement", () => {
    expect(
      mapSelection("before OLD after", "before NEW TEXT after", {
        id: "editor",
        scrollTop: 0,
        selectionDirection: "forward",
        selectionEnd: 10,
        selectionStart: 8,
      }),
    ).toMatchObject({ selectionEnd: 15, selectionStart: 15 });
  });
});
