import {
  AppController,
  EditorView,
  ConflictView,
  type AppEnvironment,
} from "../features/editor/index.js";
import { SessionCoordinator } from "../transport/session-coordinator.js";
import { BrowserRepository } from "../storage/repository.js";
import { HttpTransport } from "../transport/http-transport.js";
import { replayMutation, WebSocketTransport } from "../transport/websocket-transport.js";

export function createEditorApp(root: HTMLElement): AppController {
  const parameters = new URLSearchParams(location.search);
  const environment: AppEnvironment = {
    clock: () => Date.now(),
    isOffline: () => parameters.get("transport") === "offline" || !navigator.onLine,
    makeId: () => crypto.randomUUID(),
  };
  return new AppController(
    {
      openRepository: (callbacks) =>
        BrowserRepository.open(sessionStorage, callbacks, environment.makeId),
      http: new HttpTransport(),
      connection: (options) => new WebSocketTransport(options),
      createEditor: (handlers) => new EditorView(root, handlers),
      conflictView: new ConflictView(root),
      sessions: new SessionCoordinator(),
      replay: replayMutation,
    },
    environment,
  );
}
