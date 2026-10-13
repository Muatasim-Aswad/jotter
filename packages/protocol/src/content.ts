export { MAX_CONTENT_BYTES } from "./types.js";

const encoder = new TextEncoder();

export function normalizeContent(content: string): string {
  return content.replace(/\r\n?/gu, "\n");
}

export function contentByteLength(content: string): number {
  return encoder.encode(content).byteLength;
}
