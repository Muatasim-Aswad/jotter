import type { BrowserRepository } from "../../storage/repository.js";
import type { StorageCallbacks } from "../../storage/database.js";
import type { HttpTransport } from "../../transport/http-transport.js";
import type {
  WebSocketTransport,
  WebSocketTransportOptions,
  replayMutation,
} from "../../transport/websocket-transport.js";
import type { ConflictView } from "./conflict-view.js";
import type { EditorView, EditorHandlers } from "./view.js";
import type { SessionCoordinator } from "../../transport/session-coordinator.js";

export interface AppEnvironment {
  clock: () => number;
  isOffline: () => boolean;
  makeId: () => string;
}

export interface AppDependencies {
  openRepository: (
    callbacks: StorageCallbacks,
  ) => Promise<Pick<BrowserRepository, keyof BrowserRepository>>;
  http: Pick<HttpTransport, "bootstrap" | "resolveConflict">;
  connection: (
    options: WebSocketTransportOptions,
  ) => Pick<WebSocketTransport, "start" | "stop" | "send" | "reconnectNow">;
  createEditor: (handlers: EditorHandlers) => Pick<EditorView, keyof EditorView>;
  conflictView: Pick<ConflictView, keyof ConflictView>;
  sessions: Pick<SessionCoordinator, keyof SessionCoordinator>;
  replay: typeof replayMutation;
}
