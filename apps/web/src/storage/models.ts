import type { ConflictRecord, ScratchpadState } from "@jotter/protocol";

export interface StoredMutation {
  content: string;
  mutationId: string;
}

export interface DraftRecord {
  baseRevision: number;
  blockedByConflictId?: string;
  content: string;
  dirty: boolean;
  inFlight?: StoredMutation;
  pending?: StoredMutation;
  scratchpadId: string;
  sessionId: string;
  updatedAt: number;
}

export interface InstallationRecord {
  installationId: string;
  key: "installation";
}

export interface UiPosition {
  id: "editor";
  scrollTop: number;
  selectionDirection: "backward" | "forward" | "none";
  selectionEnd: number;
  selectionStart: number;
}

export interface ShareInboxRecord {
  createdAt: number;
  id: string;
  state: "pending" | "consumed";
  text?: string;
  title?: string;
  url?: string;
}

export interface StoredConflict extends ConflictRecord {
  proposedContent?: string;
}

export interface BootstrapRecord {
  cache?: ScratchpadState;
  conflicts: StoredConflict[];
  draft?: DraftRecord;
  installationId: string;
  orphanDrafts: DraftRecord[];
  sessionId: string;
  uiPosition?: UiPosition;
}
