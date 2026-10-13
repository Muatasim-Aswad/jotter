import { contentByteLength, MAX_CONTENT_BYTES, normalizeContent } from "@jotter/protocol";
import type { ShareInboxRecord } from "../storage/models.js";

export interface ShareAppendResult {
  content: string;
  overLimit: boolean;
  appended: boolean;
}

export function appendShare(content: string, share: ShareInboxRecord): ShareAppendResult {
  const unique = new Set<string>();
  for (const value of [share.title, share.text, share.url]) {
    if (value !== undefined && value !== "") unique.add(normalizeContent(value));
  }
  if (unique.size === 0) return { appended: false, content, overLimit: false };

  const block = [...unique].join("\n");
  const next = `${content}${content === "" ? "" : "\n\n"}${block}`;
  if (contentByteLength(next) > MAX_CONTENT_BYTES) {
    return { appended: false, content, overLimit: true };
  }
  return { appended: true, content: next, overLimit: false };
}
