import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ScratchpadState } from "@jotter/protocol";
import type {
  DraftRecord,
  InstallationRecord,
  ShareInboxRecord,
  StoredConflict,
  UiPosition,
} from "./models.js";

export const DATABASE_NAME = "jotter";
export const DATABASE_VERSION = 1;

export class StorageUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageUnavailableError";
  }
}

export interface StorageCallbacks {
  blocked?: () => void;
  terminated?: () => void;
}

export function storageLifecycle(callbacks: StorageCallbacks, close: () => void) {
  return {
    blocked: () => callbacks.blocked?.(),
    blocking: () => {
      close();
      callbacks.blocked?.();
    },
    terminated: () => callbacks.terminated?.(),
  };
}

interface JotterDatabase extends DBSchema {
  drafts: {
    key: string;
    value: DraftRecord;
    indexes: { "by-updated-at": number };
  };
  conflicts: {
    key: string;
    value: StoredConflict;
  };
  metadata: {
    key: string;
    value: InstallationRecord;
  };
  "server-cache": {
    key: string;
    value: ScratchpadState;
  };
  "share-inbox": {
    key: string;
    value: ShareInboxRecord;
  };
  "ui-position": {
    key: string;
    value: UiPosition;
  };
}

interface UpgradeDatabase {
  createObjectStore(
    name: string,
    options?: IDBObjectStoreParameters,
  ): {
    createIndex(name: string, keyPath: string): unknown;
  };
}

export function upgradeSchema(database: UpgradeDatabase, oldVersion: number): void {
  if (oldVersion >= 1) return;
  database.createObjectStore("metadata", { keyPath: "key" });
  database.createObjectStore("server-cache", { keyPath: "id" });
  const drafts = database.createObjectStore("drafts", { keyPath: "sessionId" });
  drafts.createIndex("by-updated-at", "updatedAt");
  database.createObjectStore("conflicts", { keyPath: "conflictId" });
  database.createObjectStore("share-inbox", { keyPath: "id" });
  database.createObjectStore("ui-position", { keyPath: "id" });
}

export async function openJotterDatabase(
  callbacks: StorageCallbacks = {},
): Promise<IDBPDatabase<JotterDatabase>> {
  let handle: IDBPDatabase<JotterDatabase> | undefined;
  try {
    const lifecycle = storageLifecycle(callbacks, () => handle?.close());
    handle = await openDB<JotterDatabase>(DATABASE_NAME, DATABASE_VERSION, {
      blocked: lifecycle.blocked,
      blocking: lifecycle.blocking,
      terminated: lifecycle.terminated,
      upgrade(database, oldVersion) {
        upgradeSchema(database, oldVersion);
      },
    });
    return handle;
  } catch (cause) {
    throw new StorageUnavailableError("Local storage could not be opened.", { cause });
  }
}

export type JotterDatabaseHandle = IDBPDatabase<JotterDatabase>;
