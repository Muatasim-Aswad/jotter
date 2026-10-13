import { normalizeContent, contentByteLength } from "./content.js";
import * as validators from "./validators.js";
import type { HttpPayloads } from "./types.js";
import {
  errorCodes,
  MAX_CONTENT_BYTES,
  MAX_IDENTIFIER_BYTES,
  MAX_REVISION,
  PROTOCOL_VERSION,
  type ConflictRecord,
  type Envelope,
  type ErrorCode,
  type ScratchpadState,
} from "./types.js";

export class ProtocolError extends Error {
  constructor(
    readonly code: "invalid_message" | "unsupported_version" | "content_too_large",
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function decodeEnvelope(input: string | unknown): Envelope {
  let value: unknown;
  try {
    value = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw new ProtocolError("invalid_message", "message must be valid JSON");
  }
  const object = record(value, "message");
  if (object.v !== PROTOCOL_VERSION) {
    throw new ProtocolError("unsupported_version", "protocol version is unsupported");
  }
  if (!validators.Envelope(object)) {
    if (
      validators.Envelope.errors?.some(
        (error) =>
          error.keyword === "x-max-utf8-bytes" &&
          /\/(?:content|submittedContent|serverContent)$/.test(error.instancePath),
      )
    ) {
      throw new ProtocolError("content_too_large", "content exceeds the UTF-8 byte limit");
    }
    invalid("message shape is invalid");
  }
  const type = string(object.type, "type");
  switch (type) {
    case "hello":
      return {
        v: 1,
        type,
        scratchpadId: id(object.scratchpadId, "scratchpadId"),
        clientId: id(object.clientId, "clientId"),
        sessionId: id(object.sessionId, "sessionId"),
        knownRevision: revision(object.knownRevision, "knownRevision"),
        pendingMutationIds: idArray(object.pendingMutationIds, "pendingMutationIds"),
      };
    case "state":
      return {
        v: 1,
        type,
        scratchpad: scratchpad(object.scratchpad),
        ...(object.conflicts === undefined || object.conflicts === null
          ? {}
          : { conflicts: conflictArray(object.conflicts) }),
      };
    case "save":
      return {
        v: 1,
        type,
        scratchpadId: id(object.scratchpadId, "scratchpadId"),
        content: content(object.content, "content"),
        baseRevision: revision(object.baseRevision, "baseRevision"),
        clientId: id(object.clientId, "clientId"),
        sessionId: id(object.sessionId, "sessionId"),
        mutationId: id(object.mutationId, "mutationId"),
      };
    case "ack":
      return {
        v: 1,
        type,
        scratchpadId: id(object.scratchpadId, "scratchpadId"),
        mutationId: id(object.mutationId, "mutationId"),
        revision: revision(object.revision, "revision"),
        updatedAt: timestamp(object.updatedAt, "updatedAt"),
      };
    case "update":
      return {
        v: 1,
        type,
        scratchpad: scratchpad(object.scratchpad),
        mutationId: id(object.mutationId, "mutationId"),
      };
    case "conflict": {
      const body = Object.fromEntries(conflictKeys.map((key) => [key, object[key]]));
      return { v: 1, type, ...conflict(body) };
    }
    case "error":
      return {
        v: 1,
        type,
        code: errorCode(object.code),
        message: string(object.message, "message"),
        ...(object.mutationId === undefined || object.mutationId === null
          ? {}
          : { mutationId: nullableId(object.mutationId, "mutationId") }),
        ...(object.retryAfterMs === undefined || object.retryAfterMs === null
          ? {}
          : { retryAfterMs: nonNegativeInteger(object.retryAfterMs, "retryAfterMs") }),
      };
    default:
      throw new ProtocolError("invalid_message", "message type is unsupported");
  }
}

export function encodeEnvelope(envelope: Envelope): string {
  return JSON.stringify(decodeEnvelope(envelope));
}

const conflictKeys = [
  "conflictId",
  "scratchpadId",
  "mutationId",
  "submittedContent",
  "baseRevision",
  "serverContent",
  "serverRevision",
  "clientId",
  "sessionId",
  "createdAt",
] as const;

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(`${field} must be a string`);
  return value;
}

function id(value: unknown, field: string): string {
  const result = string(value, field);
  if (result.length === 0 || contentByteLength(result) > MAX_IDENTIFIER_BYTES)
    invalid(`${field} must contain 1 to 128 characters`);
  return result;
}

function nullableId(value: unknown, field: string): string | null {
  return value === null ? null : id(value, field);
}

function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_REVISION) {
    invalid(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  return revision(value, field);
}

function content(value: unknown, field: string): string {
  const result = normalizeContent(string(value, field));
  if (contentByteLength(result) > MAX_CONTENT_BYTES) {
    throw new ProtocolError(
      "content_too_large",
      `${field} exceeds ${MAX_CONTENT_BYTES} UTF-8 bytes`,
    );
  }
  return result;
}

function timestamp(value: unknown, field: string): string {
  const result = string(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(result) ||
    Number.isNaN(Date.parse(result))
  ) {
    invalid(`${field} must be a UTC RFC 3339 timestamp`);
  }
  return result;
}

function idArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array`);
  return value.map((item, index) => id(item, `${field}[${index}]`));
}

function scratchpad(value: unknown): ScratchpadState {
  const object = record(value, "scratchpad");
  return {
    id: id(object.id, "scratchpad.id"),
    content: content(object.content, "scratchpad.content"),
    revision: revision(object.revision, "scratchpad.revision"),
    updatedAt: timestamp(object.updatedAt, "scratchpad.updatedAt"),
  };
}

function conflict(value: unknown): ConflictRecord {
  const object = record(value, "conflict");
  return {
    conflictId: id(object.conflictId, "conflictId"),
    scratchpadId: id(object.scratchpadId, "scratchpadId"),
    mutationId: id(object.mutationId, "mutationId"),
    submittedContent: content(object.submittedContent, "submittedContent"),
    baseRevision: revision(object.baseRevision, "baseRevision"),
    serverContent: content(object.serverContent, "serverContent"),
    serverRevision: revision(object.serverRevision, "serverRevision"),
    clientId: id(object.clientId, "clientId"),
    sessionId: id(object.sessionId, "sessionId"),
    createdAt: timestamp(object.createdAt, "createdAt"),
  };
}

function conflictArray(value: unknown): ConflictRecord[] {
  if (!Array.isArray(value)) invalid("conflicts must be an array or null");
  return value.map(conflict);
}

function errorCode(value: unknown): ErrorCode {
  const result = string(value, "code") as ErrorCode;
  if (!errorCodes.includes(result)) invalid("code is unsupported");
  return result;
}

function invalid(message: string): never {
  throw new ProtocolError("invalid_message", message);
}

export function decodeHttp<N extends keyof HttpPayloads>(name: N, value: unknown): HttpPayloads[N] {
  if (!validators[name](value)) invalid("HTTP payload does not match its contract");
  if (name === "BootstrapResponse") {
    const state = decodeEnvelope({
      v: 1,
      type: "state",
      ...(value as object),
    }) as import("./types.js").StateEnvelope;
    return { scratchpad: state.scratchpad, conflicts: state.conflicts ?? [] } as HttpPayloads[N];
  }
  if (name === "ResolveResponse") {
    const state = decodeEnvelope({
      v: 1,
      type: "state",
      scratchpad: value,
    }) as import("./types.js").StateEnvelope;
    return state.scratchpad as HttpPayloads[N];
  }
  return value as HttpPayloads[N];
}
