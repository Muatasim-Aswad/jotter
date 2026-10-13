import type { ScratchpadState } from "@jotter/protocol";
import type { BrowserRepository } from "../../storage/repository.js";
import type { DraftRecord, StoredConflict } from "../../storage/models.js";
import { HttpTransportError, type HttpTransport } from "../../transport/http-transport.js";
import { SyncMachine } from "./sync.js";

type ConflictStore = Pick<
  BrowserRepository,
  "saveConflict" | "completeResolution" | "completeOrphanResolution"
>;
type ConflictClient = Pick<HttpTransport, "bootstrap" | "resolveConflict">;
type Resolution =
  | { kind: "committed"; state: ScratchpadState; resumed?: DraftRecord }
  | { kind: "review" | "failed"; conflict: StoredConflict; message: string };

export class ConflictResolution {
  constructor(
    private readonly repository: ConflictStore,
    private readonly http: ConflictClient,
    private readonly clock: () => number,
  ) {}

  async resolve(
    conflict: StoredConflict,
    content: string,
    machine: SyncMachine,
  ): Promise<Resolution> {
    try {
      const bootstrap = await this.http.bootstrap();
      if (bootstrap.scratchpad.revision !== conflict.serverRevision) {
        return await this.refresh(conflict, bootstrap.scratchpad, content);
      }
      const state = await this.http.resolveConflict(
        conflict.conflictId,
        content,
        bootstrap.scratchpad.revision,
      );
      if (conflict.sessionId === machine.snapshot.sessionId) {
        const next = new SyncMachine(machine.snapshot.sessionId);
        next.hydrate(machine.toDraft(this.clock()));
        next.resolve(state);
        await this.repository.completeResolution(
          conflict.conflictId,
          next.toDraft(this.clock()),
          state,
        );
        machine.resolve(state);
        return { kind: "committed", state };
      }
      const resumed = await this.repository.completeOrphanResolution(
        conflict.conflictId,
        state.revision,
      );
      return { kind: "committed", state, resumed };
    } catch (error) {
      if (error instanceof HttpTransportError && error.code === "stale_revision") {
        try {
          return await this.refresh(conflict, (await this.http.bootstrap()).scratchpad, content);
        } catch {
          /* Preserve the proposed text when refresh is also unavailable. */
        }
      }
      const preserved = { ...conflict, proposedContent: content };
      await this.repository.saveConflict(preserved);
      return {
        kind: "failed",
        conflict: preserved,
        message: "The resolution could not be saved. Your attempted result is preserved.",
      };
    }
  }

  private async refresh(
    conflict: StoredConflict,
    server: ScratchpadState,
    proposedContent: string,
  ): Promise<Resolution> {
    const refreshed = {
      ...conflict,
      proposedContent,
      serverContent: server.content,
      serverRevision: server.revision,
    };
    await this.repository.saveConflict(refreshed);
    return {
      kind: "review",
      conflict: refreshed,
      message: "The server changed again. Review the newest version before resolving.",
    };
  }
}
