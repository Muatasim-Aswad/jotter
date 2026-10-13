import {
  contentByteLength,
  MAX_CONTENT_BYTES,
  normalizeContent,
  type ConflictRecord,
  type ScratchpadState,
} from "@jotter/protocol";
import type { DraftRecord, StoredMutation } from "../../storage/models.js";

export type SyncStatus =
  | "bootstrapping"
  | "clean"
  | "dirty"
  | "saving"
  | "offline"
  | "conflicted"
  | "failed";

export interface SyncSnapshot {
  baseRevision: number;
  conflict?: ConflictRecord;
  content: string;
  dirty: boolean;
  error?: string;
  inFlight?: StoredMutation;
  pending?: StoredMutation;
  scratchpadId: string;
  sessionId: string;
  status: SyncStatus;
}

export interface Acknowledgement {
  mutationId: string;
  revision: number;
  updatedAt: string;
}

export class ContentLimitError extends Error {
  constructor() {
    super(`Scratchpad content is limited to ${MAX_CONTENT_BYTES.toLocaleString()} UTF-8 bytes.`);
    this.name = "ContentLimitError";
  }
}

export class SyncMachine {
  private state: SyncSnapshot;

  constructor(sessionId: string) {
    this.state = {
      baseRevision: 0,
      content: "",
      dirty: false,
      scratchpadId: "",
      sessionId,
      status: "bootstrapping",
    };
  }

  get snapshot(): Readonly<SyncSnapshot> {
    return this.state;
  }

  hydrate(draft: DraftRecord): Readonly<SyncSnapshot> {
    this.state = {
      baseRevision: draft.baseRevision,
      content: draft.content,
      dirty: draft.dirty,
      ...(draft.inFlight ? { inFlight: draft.inFlight } : {}),
      ...(draft.pending ? { pending: draft.pending } : {}),
      scratchpadId: draft.scratchpadId,
      sessionId: draft.sessionId,
      status: draft.dirty ? "dirty" : "clean",
    };
    return this.snapshot;
  }

  bootstrap(server: ScratchpadState): Readonly<SyncSnapshot> {
    this.state = {
      baseRevision: server.revision,
      content: server.content,
      dirty: false,
      scratchpadId: server.id,
      sessionId: this.state.sessionId,
      status: "clean",
    };
    return this.snapshot;
  }

  edit(content: string, makeMutationId: () => string): Readonly<SyncSnapshot> {
    if (this.state.status === "conflicted") return this.snapshot;
    const normalized = normalizeContent(content);
    if (contentByteLength(normalized) > MAX_CONTENT_BYTES) throw new ContentLimitError();
    const pending: StoredMutation = {
      content: normalized,
      mutationId: this.state.pending?.mutationId ?? makeMutationId(),
    };
    this.state = {
      ...this.state,
      content: normalized,
      dirty: true,
      error: undefined,
      pending,
      status: "dirty",
    };
    return this.snapshot;
  }

  beginSave(): StoredMutation | undefined {
    if (this.state.inFlight || !this.state.pending || this.state.status === "conflicted") {
      return undefined;
    }
    const inFlight = this.state.pending;
    this.state = { ...this.state, inFlight, pending: undefined, status: "saving" };
    return inFlight;
  }

  acknowledge(acknowledgement: Acknowledgement): ScratchpadState | undefined {
    if (this.state.inFlight?.mutationId !== acknowledgement.mutationId) return undefined;
    const acknowledgedContent = this.state.inFlight.content;
    const dirty = this.state.pending !== undefined;
    this.state = {
      ...this.state,
      baseRevision: acknowledgement.revision,
      dirty,
      error: undefined,
      inFlight: undefined,
      status: dirty ? "dirty" : "clean",
    };
    return {
      content: acknowledgedContent,
      id: this.state.scratchpadId,
      revision: acknowledgement.revision,
      updatedAt: acknowledgement.updatedAt,
    };
  }

  applyRemote(server: ScratchpadState): ScratchpadState | undefined {
    if (
      this.state.dirty ||
      this.state.status === "conflicted" ||
      server.revision <= this.state.baseRevision
    ) {
      return undefined;
    }
    this.state = {
      ...this.state,
      baseRevision: server.revision,
      content: server.content,
      error: undefined,
      scratchpadId: server.id,
      status: "clean",
    };
    return server;
  }

  pendingMutationIds(): string[] {
    return [this.state.inFlight?.mutationId, this.state.pending?.mutationId].filter(
      (value): value is string => value !== undefined,
    );
  }

  replaceMutationIdentity(mutationId: string, makeId: () => string): boolean {
    if (this.state.inFlight?.mutationId !== mutationId) return false;
    this.state = {
      ...this.state,
      inFlight: { ...this.state.inFlight, mutationId: makeId() },
    };
    return true;
  }

  setOffline(): Readonly<SyncSnapshot> {
    if (this.state.status === "conflicted" || this.state.status === "failed") return this.snapshot;
    this.state = { ...this.state, status: "offline" };
    return this.snapshot;
  }

  setOnline(): Readonly<SyncSnapshot> {
    if (this.state.status === "conflicted" || this.state.status === "failed") return this.snapshot;
    this.state = {
      ...this.state,
      error: undefined,
      status: this.state.inFlight ? "saving" : this.state.dirty ? "dirty" : "clean",
    };
    return this.snapshot;
  }

  fail(message: string): Readonly<SyncSnapshot> {
    this.state = { ...this.state, error: message, status: "failed" };
    return this.snapshot;
  }

  conflict(conflict: ConflictRecord): Readonly<SyncSnapshot> {
    this.state = {
      ...this.state,
      conflict,
      dirty: true,
      ...(this.state.inFlight?.mutationId === conflict.mutationId ? { inFlight: undefined } : {}),
      status: "conflicted",
    };
    return this.snapshot;
  }

  resolve(server: ScratchpadState): Readonly<SyncSnapshot> {
    const pending = this.state.pending;
    this.state = {
      baseRevision: server.revision,
      content: pending?.content ?? server.content,
      dirty: pending !== undefined,
      ...(pending ? { pending } : {}),
      scratchpadId: server.id,
      sessionId: this.state.sessionId,
      status: pending ? "dirty" : "clean",
    };
    return this.snapshot;
  }

  toDraft(updatedAt: number): DraftRecord {
    return {
      baseRevision: this.state.baseRevision,
      content: this.state.content,
      dirty: this.state.dirty,
      ...(this.state.inFlight ? { inFlight: this.state.inFlight } : {}),
      ...(this.state.pending ? { pending: this.state.pending } : {}),
      scratchpadId: this.state.scratchpadId,
      sessionId: this.state.sessionId,
      updatedAt,
    };
  }
}
