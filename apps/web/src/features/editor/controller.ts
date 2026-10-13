import { ConflictResolution } from "./conflict-resolution.js";
import type { AppDependencies, AppEnvironment } from "./dependencies.js";
import { OrphanRecovery } from "./orphan-recovery.js";
import type {
  AckEnvelope,
  ConflictEnvelope,
  ErrorEnvelope,
  SaveEnvelope,
  ScratchpadState,
  StateEnvelope,
  UpdateEnvelope,
} from "@jotter/protocol";
import type { DraftRecord, StoredConflict, UiPosition } from "../../storage/models.js";
import { makeDraft } from "../../storage/repository.js";
import { ContentLimitError, SyncMachine } from "./sync.js";
const SAVE_DELAY_MILLISECONDS = 300;

class FirstLoadOfflineError extends Error {}

export class AppController {
  private activeConflict?: StoredConflict;
  private connected = false;
  private conflictView: AppDependencies["conflictView"];
  private resolution?: ConflictResolution;
  private editorPosition?: UiPosition;
  private flushTimer?: number;
  private http: AppDependencies["http"];
  private installation?: string;
  private latestServer?: ScratchpadState;
  private machine?: SyncMachine;
  private recovery?: OrphanRecovery;
  private pendingShareBlocked = false;
  private persistChain: Promise<void> = Promise.resolve();
  private repository?: Awaited<ReturnType<AppDependencies["openRepository"]>>;
  private sessionCoordinator: AppDependencies["sessions"];
  private showingConflict = false;
  private transport?: ReturnType<AppDependencies["connection"]>;
  private view: ReturnType<AppDependencies["createEditor"]>;

  constructor(
    private readonly dependencies: AppDependencies,
    private readonly environment: AppEnvironment,
  ) {
    this.view = dependencies.createEditor({
      onFlush: () => void this.flush(),
      onInput: (content) => this.input(content),
      onPosition: (position) => this.savePosition(position),
    });
    this.conflictView = dependencies.conflictView;
    this.http = dependencies.http;
    this.sessionCoordinator = dependencies.sessions;
  }

  async start(): Promise<void> {
    window.addEventListener("online", this.online);
    window.addEventListener("offline", this.offline);
    document.addEventListener("visibilitychange", this.visibilityChanged);
    window.addEventListener("pagehide", this.pageHidden);
    try {
      const activeSessions = await this.sessionCoordinator.discover();
      this.repository = await this.dependencies.openRepository({
        blocked: () =>
          this.view.showFatal("Close other Jotter tabs so local storage can be upgraded."),
        terminated: () => this.storageFailed("Local storage closed unexpectedly."),
      });
      this.resolution = new ConflictResolution(this.repository, this.http, this.environment.clock);
      const local = await this.repository.load(activeSessions);
      this.installation = local.installationId;
      this.recovery = new OrphanRecovery(
        this.repository,
        local.orphanDrafts,
        this.dependencies.replay,
        this.environment.makeId,
      );
      this.editorPosition = local.uiPosition;
      this.sessionCoordinator.announce(local.sessionId);
      this.machine = new SyncMachine(local.sessionId);
      let draft: DraftRecord;

      if (local.draft) {
        draft = local.draft;
        this.machine.hydrate(draft);
      } else if (local.cache) {
        this.machine.bootstrap(local.cache);
        draft = makeDraft(local.sessionId, local.cache, this.environment.clock());
        await this.repository.saveDraft(draft);
      } else {
        if (this.environment.isOffline()) throw new FirstLoadOfflineError();
        const bootstrap = await this.http.bootstrap();
        this.latestServer = bootstrap.scratchpad;
        this.machine.bootstrap(bootstrap.scratchpad);
        draft = makeDraft(local.sessionId, bootstrap.scratchpad, this.environment.clock());
        await Promise.all([
          this.repository.saveServerCache(bootstrap.scratchpad),
          this.repository.saveDraft(draft),
          ...bootstrap.conflicts
            .filter((conflict) => conflict.clientId === local.installationId)
            .map((conflict) => this.repository?.saveConflict(conflict)),
        ]);
      }

      const shares = await this.repository.consumePendingShares(draft, this.environment.clock());
      const consumedShare = shares.consumedShareIds.length > 0;
      if (consumedShare) this.machine.hydrate(shares.draft);
      const position = consumedShare ? endPosition(shares.draft.content) : local.uiPosition;
      this.editorPosition = position;
      this.view.mount(this.machine.snapshot.content, position, true);
      if (shares.blockedShareId) {
        this.pendingShareBlocked = true;
        this.showPendingShareError();
      }

      this.configureTransport();
      await this.showNextConflict();
      if (this.environment.isOffline()) this.showOffline();
      else this.transport?.start();
    } catch (error) {
      this.view.showFatal(
        error instanceof FirstLoadOfflineError
          ? "Jotter has not been loaded on this device yet. Connect once, then try again."
          : "Jotter could not open local data or reach the server. Your document is unavailable.",
      );
    }
  }

  stop(): void {
    window.clearTimeout(this.flushTimer);
    this.transport?.stop();
    this.sessionCoordinator.close();
    this.repository?.close();
    window.removeEventListener("online", this.online);
    window.removeEventListener("offline", this.offline);
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    window.removeEventListener("pagehide", this.pageHidden);
  }

  private configureTransport(): void {
    if (!this.machine || !this.installation) return;
    this.transport = this.dependencies.connection({
      getHello: () => {
        const snapshot = this.machine?.snapshot;
        if (!snapshot) throw new Error("Sync state is unavailable.");
        return {
          clientId: this.installation ?? "unavailable",
          knownRevision: snapshot.baseRevision,
          pendingMutationIds: this.machine?.pendingMutationIds() ?? [],
          scratchpadId: snapshot.scratchpadId,
          sessionId: snapshot.sessionId,
          type: "hello",
          v: 1,
        };
      },
      onConnectivity: (connected) => {
        this.connected = connected;
        if (!connected) this.showOffline();
      },
      onEnvelope: (envelope) => void this.handleEnvelope(envelope),
    });
  }

  private input(content: string): void {
    if (!this.machine || !this.repository) return;
    const previous = this.machine.snapshot.content;
    try {
      this.machine.edit(content, this.environment.makeId);
    } catch (error) {
      this.view.restoreContent(previous);
      this.view.showError(
        error instanceof ContentLimitError ? error.message : "This edit could not be accepted.",
      );
      return;
    }

    const draft = this.machine.toDraft(this.environment.clock());
    this.persistChain = this.persistChain
      .then(() => this.repository?.saveDraft(draft))
      .then(() => this.view.markPersisted())
      .catch((error: unknown) => this.storageFailed(error));
    window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => void this.flush(), SAVE_DELAY_MILLISECONDS);
  }

  private async flush(): Promise<void> {
    await this.persistChain;
    if (!this.machine || !this.repository || !this.transport) return;
    if (
      !this.connected ||
      this.environment.isOffline() ||
      this.machine.snapshot.status === "failed" ||
      this.machine.snapshot.status === "conflicted"
    ) {
      return;
    }

    const mutation = this.machine.snapshot.inFlight ?? this.machine.beginSave();
    if (!mutation) return;
    await this.repository.saveDraft(this.machine.toDraft(this.environment.clock()));
    const snapshot = this.machine.snapshot;
    const envelope: SaveEnvelope = {
      baseRevision: snapshot.baseRevision,
      clientId: this.installation ?? "unavailable",
      content: mutation.content,
      mutationId: mutation.mutationId,
      scratchpadId: snapshot.scratchpadId,
      sessionId: snapshot.sessionId,
      type: "save",
      v: 1,
    };
    if (!this.transport.send(envelope)) this.showOffline();
  }

  private async handleEnvelope(
    envelope: StateEnvelope | AckEnvelope | UpdateEnvelope | ConflictEnvelope | ErrorEnvelope,
  ): Promise<void> {
    try {
      switch (envelope.type) {
        case "state":
          await this.handleState(envelope);
          break;
        case "ack":
          await this.handleAcknowledgement(envelope);
          break;
        case "update":
          await this.handleUpdate(envelope);
          break;
        case "conflict":
          await this.handleConflict(envelope);
          break;
        case "error":
          await this.handleTransportError(envelope);
          break;
      }
    } catch (error) {
      this.storageFailed(error);
    }
  }

  private async handleState(envelope: StateEnvelope): Promise<void> {
    if (!this.machine || !this.repository) return;
    this.latestServer = newer(this.latestServer, envelope.scratchpad);
    const conflicts = (envelope.conflicts ?? []).filter(
      (conflict) => conflict.clientId === this.installation,
    );
    for (const conflict of conflicts) await this.repository.saveConflict(conflict);
    const current = conflicts.find(
      (conflict) => conflict.sessionId === this.machine?.snapshot.sessionId,
    );
    if (current) {
      this.machine.conflict(current);
      await this.repository.saveDraft(this.machine.toDraft(this.environment.clock()));
    } else {
      await this.applyRemote(envelope.scratchpad);
      this.machine.setOnline();
    }
    this.clearTransientError();
    await this.showNextConflict();
    await this.flush();
    void this.replayOrphans();
  }

  private async handleAcknowledgement(envelope: AckEnvelope): Promise<void> {
    if (!this.machine || !this.repository) return;
    const cache = this.machine.acknowledge(envelope);
    if (!cache) return;
    await this.repository.acknowledge(this.machine.toDraft(this.environment.clock()), cache);
    this.view.markAcknowledged(cache.revision);
    this.clearTransientError();
    void navigator.storage?.persist?.().catch(() => false);
    if (!this.machine.snapshot.pending && this.latestServer) {
      await this.applyRemote(this.latestServer);
    }
    if (this.machine.snapshot.pending) void this.flush();
  }

  private async handleUpdate(envelope: UpdateEnvelope): Promise<void> {
    this.latestServer = newer(this.latestServer, envelope.scratchpad);
    await this.applyRemote(envelope.scratchpad);
  }

  private async handleConflict(envelope: ConflictEnvelope): Promise<void> {
    if (!this.machine || !this.repository) return;
    this.machine.conflict(envelope);
    await this.repository.saveConflict(envelope);
    await this.repository.saveDraft(this.machine.toDraft(this.environment.clock()));
    await this.showNextConflict();
  }

  private async handleTransportError(envelope: ErrorEnvelope): Promise<void> {
    if (
      envelope.code === "mutation_mismatch" &&
      envelope.mutationId &&
      this.machine?.replaceMutationIdentity(envelope.mutationId, this.environment.makeId)
    ) {
      await this.repository?.saveDraft(this.machine.toDraft(this.environment.clock()));
      await this.flush();
      return;
    }
    const message =
      envelope.code === "unresolved_conflict"
        ? "Resolve this device's conflict before saving more changes."
        : envelope.message;
    if (this.showingConflict) this.conflictView.showError(message);
    else this.view.showError(message);
  }

  private async applyRemote(server: ScratchpadState): Promise<void> {
    if (!this.machine || !this.repository) return;
    const applied = this.machine.applyRemote(server);
    if (!applied) return;
    await this.repository.acknowledge(this.machine.toDraft(this.environment.clock()), applied);
    if (!this.showingConflict) this.view.applyRemoteContent(applied.content);
  }

  private async showNextConflict(): Promise<void> {
    if (!this.repository || !this.machine || !this.installation) return;
    const conflicts = (await this.repository.listConflicts()).filter(
      (conflict) => conflict.clientId === this.installation,
    );
    const next = conflicts[0];
    if (!next) {
      this.activeConflict = undefined;
      if (this.showingConflict) {
        this.showingConflict = false;
        this.view.mount(this.machine.snapshot.content, this.editorPosition, false);
      }
      return;
    }
    if (!this.showingConflict) this.editorPosition = this.view.position();
    this.showingConflict = true;
    this.activeConflict = next;
    if (next.sessionId === this.machine.snapshot.sessionId) this.machine.conflict(next);
    this.conflictView.mount(next, { onResolve: (content) => void this.resolveConflict(content) });
  }

  private async resolveConflict(content: string): Promise<void> {
    const conflict = this.activeConflict;
    if (!conflict || !this.machine || !this.resolution) return;
    try {
      const result = await this.resolution.resolve(conflict, content, this.machine);
      if (result.kind !== "committed") {
        this.activeConflict = result.conflict;
        this.conflictView.mount(result.conflict, {
          onResolve: (text) => void this.resolveConflict(text),
        });
        this.conflictView.showError(result.message);
        return;
      }
      this.latestServer = newer(this.latestServer, result.state);
      if (result.resumed) this.recovery?.replace(result.resumed);
      if (conflict.sessionId !== this.machine.snapshot.sessionId)
        await this.applyRemote(result.state);
      this.activeConflict = undefined;
      await this.showNextConflict();
      await this.flush();
      void this.replayOrphans();
    } catch (error) {
      this.storageFailed(error);
    }
  }

  private async replayOrphans(): Promise<void> {
    if (!this.recovery || !this.installation) return;
    try {
      await this.recovery.run(
        this.installation,
        () => this.connected,
        () => this.showNextConflict(),
      );
    } catch (error) {
      this.view.showError(
        error instanceof Error ? error.message : "An offline draft could not be replayed.",
      );
    }
  }

  private savePosition(position: UiPosition): void {
    this.editorPosition = position;
    void this.repository
      ?.saveUiPosition(position)
      .catch((error: unknown) => this.storageFailed(error));
  }

  private storageFailed(error: unknown): void {
    const message = error instanceof Error ? error.message : "Local storage failed.";
    this.machine?.fail(message);
    if (this.showingConflict) this.conflictView.showError(message);
    else this.view.showError(message);
  }

  private clearTransientError(): void {
    if (!this.connected || this.environment.isOffline()) {
      this.showOffline();
    } else if (!this.pendingShareBlocked) {
      this.view.clearError();
    }
  }

  private showPendingShareError(): void {
    this.view.showError(
      "A shared item is waiting. Shorten the scratchpad below the 1 MiB limit, then reload.",
    );
  }

  private showOffline(): void {
    this.machine?.setOffline();
    if (this.pendingShareBlocked) {
      this.showPendingShareError();
      return;
    }
    const message = "Offline. Changes remain saved on this device.";
    if (this.showingConflict) this.conflictView.showError(message);
    else this.view.showError(message);
  }

  private readonly online = (): void => {
    this.transport?.start();
    this.transport?.reconnectNow();
  };

  private readonly offline = (): void => this.showOffline();

  private readonly visibilityChanged = (): void => {
    if (document.visibilityState === "hidden") void this.flush();
  };

  private readonly pageHidden = (): void => {
    void this.flush();
  };
}

function newer(current: ScratchpadState | undefined, candidate: ScratchpadState): ScratchpadState {
  return !current || candidate.revision > current.revision ? candidate : current;
}

function endPosition(content: string): UiPosition {
  return {
    id: "editor",
    scrollTop: Number.MAX_SAFE_INTEGER,
    selectionDirection: "none",
    selectionEnd: content.length,
    selectionStart: content.length,
  };
}
