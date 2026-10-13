import type { ScratchpadState } from "@jotter/protocol";
import { appendShare } from "../share/append.js";
import {
  openJotterDatabase,
  StorageUnavailableError,
  type JotterDatabaseHandle,
  type StorageCallbacks,
} from "./database.js";
import type {
  BootstrapRecord,
  DraftRecord,
  ShareInboxRecord,
  StoredConflict,
  UiPosition,
} from "./models.js";

const SESSION_KEY = "jotter.session-id";

export interface BrowserStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ShareConsumptionResult {
  blockedShareId?: string;
  consumedShareIds: string[];
  draft: DraftRecord;
}

export class BrowserRepository {
  private constructor(
    private readonly database: JotterDatabaseHandle,
    private readonly sessionStorage: BrowserStorageLike,
    private readonly makeId: () => string,
  ) {}

  static async open(
    sessionStorage: BrowserStorageLike,
    callbacks: StorageCallbacks = {},
    makeId: () => string = () => crypto.randomUUID(),
  ): Promise<BrowserRepository> {
    return new BrowserRepository(await openJotterDatabase(callbacks), sessionStorage, makeId);
  }

  async load(activeSessionIds: ReadonlySet<string>): Promise<BootstrapRecord> {
    const installationId = await this.ensureInstallationId();
    const storedSessionId = this.sessionStorage.getItem(SESSION_KEY);
    const drafts = await this.database.getAll("drafts");
    const sessionId = selectSessionId(storedSessionId, drafts, activeSessionIds, this.makeId);
    this.sessionStorage.setItem(SESSION_KEY, sessionId);

    const [draft, cache, uiPosition, conflicts] = await Promise.all([
      this.database.get("drafts", sessionId),
      this.firstServerCache(),
      this.database.get("ui-position", "editor"),
      this.database.getAll("conflicts"),
    ]);
    return {
      conflicts: orderConflicts(conflicts),
      installationId,
      orphanDrafts: orderOrphanDrafts(
        drafts.filter(
          (candidate) =>
            candidate.dirty &&
            candidate.sessionId !== sessionId &&
            !activeSessionIds.has(candidate.sessionId),
        ),
      ),
      sessionId,
      ...(draft ? { draft } : {}),
      ...(cache ? { cache } : {}),
      ...(uiPosition ? { uiPosition } : {}),
    };
  }

  async saveDraft(draft: DraftRecord): Promise<void> {
    try {
      await this.database.put("drafts", draft);
    } catch (cause) {
      throw new StorageUnavailableError("The latest edit could not be saved on this device.", {
        cause,
      });
    }
  }

  async consumePendingShares(
    draft: DraftRecord,
    updatedAt: number,
  ): Promise<ShareConsumptionResult> {
    const transaction = this.database.transaction(["drafts", "share-inbox"], "readwrite");
    try {
      const inbox = transaction.objectStore("share-inbox");
      const drafts = transaction.objectStore("drafts");
      const shares = orderPendingShares(await inbox.getAll());
      const consumedShareIds: string[] = [];
      let current = draft;
      let blockedShareId: string | undefined;

      for (const share of shares) {
        const appended = appendShare(current.content, share);
        if (appended.overLimit) {
          blockedShareId = share.id;
          break;
        }
        if (appended.appended) {
          current = {
            ...current,
            content: appended.content,
            dirty: true,
            pending: {
              content: appended.content,
              mutationId: current.pending?.mutationId ?? this.makeId(),
            },
            updatedAt,
          };
          await drafts.put(current);
        }
        await inbox.put({ ...share, state: "consumed" });
        consumedShareIds.push(share.id);
      }
      await transaction.done;
      return {
        ...(blockedShareId ? { blockedShareId } : {}),
        consumedShareIds,
        draft: current,
      };
    } catch (cause) {
      try {
        transaction.abort();
      } catch {
        // A request failure may already have aborted the transaction.
      }
      throw new StorageUnavailableError("A shared item could not be committed locally.", { cause });
    }
  }

  async acknowledge(draft: DraftRecord, cache: ScratchpadState): Promise<void> {
    try {
      const transaction = this.database.transaction(["drafts", "server-cache"], "readwrite");
      await Promise.all([
        transaction.objectStore("drafts").put(draft),
        transaction.objectStore("server-cache").put(cache),
        transaction.done,
      ]);
    } catch (cause) {
      throw new StorageUnavailableError("The saved revision could not be recorded locally.", {
        cause,
      });
    }
  }

  async completeResolution(
    conflictId: string,
    draft: DraftRecord,
    cache: ScratchpadState,
  ): Promise<void> {
    try {
      const transaction = this.database.transaction(
        ["conflicts", "drafts", "server-cache"],
        "readwrite",
      );
      await Promise.all([
        transaction.objectStore("conflicts").delete(conflictId),
        transaction.objectStore("drafts").put(draft),
        transaction.objectStore("server-cache").put(cache),
        transaction.done,
      ]);
    } catch (cause) {
      throw new StorageUnavailableError("The resolved conflict could not be recorded locally.", {
        cause,
      });
    }
  }

  async saveServerCache(cache: ScratchpadState): Promise<void> {
    try {
      await this.database.put("server-cache", cache);
    } catch (cause) {
      throw new StorageUnavailableError("The server copy could not be cached locally.", { cause });
    }
  }

  async saveConflict(conflict: StoredConflict): Promise<void> {
    try {
      await this.database.put("conflicts", conflict);
    } catch (cause) {
      throw new StorageUnavailableError("The conflict could not be preserved locally.", { cause });
    }
  }

  async listConflicts(): Promise<StoredConflict[]> {
    return orderConflicts(await this.database.getAll("conflicts"));
  }

  async deleteConflict(conflictId: string): Promise<void> {
    try {
      await this.database.delete("conflicts", conflictId);
    } catch (cause) {
      throw new StorageUnavailableError("The resolved conflict could not be removed locally.", {
        cause,
      });
    }
  }

  async getDraft(sessionId: string): Promise<DraftRecord | undefined> {
    return this.database.get("drafts", sessionId);
  }

  async deleteDraft(sessionId: string): Promise<void> {
    try {
      await this.database.delete("drafts", sessionId);
    } catch (cause) {
      throw new StorageUnavailableError("A completed local draft could not be removed.", { cause });
    }
  }

  async completeOrphanResolution(
    conflictId: string,
    baseRevision: number,
  ): Promise<DraftRecord | undefined> {
    try {
      const transaction = this.database.transaction(["conflicts", "drafts"], "readwrite");
      const drafts = await transaction.objectStore("drafts").getAll();
      const draft = drafts.find((candidate) => candidate.blockedByConflictId === conflictId);
      const resumed = draft
        ? { ...draft, baseRevision, blockedByConflictId: undefined }
        : undefined;
      await Promise.all([
        transaction.objectStore("conflicts").delete(conflictId),
        ...(resumed ? [transaction.objectStore("drafts").put(resumed)] : []),
        transaction.done,
      ]);
      return resumed;
    } catch (cause) {
      throw new StorageUnavailableError("The resolved offline draft could not be resumed.", {
        cause,
      });
    }
  }

  async saveUiPosition(position: UiPosition): Promise<void> {
    try {
      await this.database.put("ui-position", position);
    } catch (cause) {
      throw new StorageUnavailableError("The editor position could not be saved.", { cause });
    }
  }

  close(): void {
    this.database.close();
  }

  private async ensureInstallationId(): Promise<string> {
    const existing = await this.database.get("metadata", "installation");
    if (existing) return existing.installationId;
    const installationId = this.makeId();
    try {
      await this.database.put("metadata", { key: "installation", installationId });
      return installationId;
    } catch (cause) {
      throw new StorageUnavailableError("This installation could not be identified.", { cause });
    }
  }

  private async firstServerCache(): Promise<ScratchpadState | undefined> {
    const cursor = await this.database.transaction("server-cache").store.openCursor();
    return cursor?.value;
  }
}

export function selectSessionId(
  storedSessionId: string | null,
  drafts: readonly DraftRecord[],
  activeSessionIds: ReadonlySet<string>,
  makeId: () => string,
): string {
  if (storedSessionId) return storedSessionId;
  const resumable = drafts
    .filter((draft) => draft.dirty && !activeSessionIds.has(draft.sessionId))
    .toSorted(
      (left, right) =>
        right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId),
    );
  return resumable[0]?.sessionId ?? makeId();
}

export function orderOrphanDrafts(drafts: readonly DraftRecord[]): DraftRecord[] {
  return drafts.toSorted(
    (left, right) =>
      left.updatedAt - right.updatedAt || left.sessionId.localeCompare(right.sessionId),
  );
}

export function orderConflicts(conflicts: readonly StoredConflict[]): StoredConflict[] {
  return conflicts.toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.conflictId.localeCompare(right.conflictId),
  );
}

export function orderPendingShares(shares: readonly ShareInboxRecord[]): ShareInboxRecord[] {
  return shares
    .filter((share) => share.state === "pending")
    .toSorted((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export function makeDraft(
  sessionId: string,
  scratchpad: ScratchpadState,
  updatedAt: number,
): DraftRecord {
  return {
    baseRevision: scratchpad.revision,
    content: scratchpad.content,
    dirty: false,
    scratchpadId: scratchpad.id,
    sessionId,
    updatedAt,
  };
}
