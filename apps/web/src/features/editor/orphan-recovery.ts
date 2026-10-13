import type { AckEnvelope, ConflictEnvelope, HelloEnvelope, SaveEnvelope } from "@jotter/protocol";
import type { DraftRecord } from "../../storage/models.js";
import type { BrowserRepository } from "../../storage/repository.js";

type RecoveryStore = Pick<BrowserRepository, "saveDraft" | "deleteDraft" | "saveConflict">;
type Replay = (hello: HelloEnvelope, save: SaveEnvelope) => Promise<AckEnvelope | ConflictEnvelope>;

export class OrphanRecovery {
  private replaying = false;
  constructor(
    private readonly repository: RecoveryStore,
    private drafts: DraftRecord[],
    private readonly replay: Replay,
    private readonly makeId: () => string,
  ) {}

  async run(
    clientId: string,
    online: () => boolean,
    onConflict: () => Promise<void>,
  ): Promise<void> {
    if (this.replaying || !online()) return;
    this.replaying = true;
    try {
      while (online()) {
        const draft = this.drafts.find((candidate) => !candidate.blockedByConflictId);
        if (!draft) break;
        const mutation = draft.inFlight ?? draft.pending;
        if (!mutation) break;
        let result: AckEnvelope | ConflictEnvelope;
        try {
          result = await this.replay(
            {
              clientId,
              knownRevision: draft.baseRevision,
              pendingMutationIds: [draft.inFlight?.mutationId, draft.pending?.mutationId].filter(
                (id): id is string => id !== undefined,
              ),
              scratchpadId: draft.scratchpadId,
              sessionId: draft.sessionId,
              type: "hello",
              v: 1,
            },
            {
              baseRevision: draft.baseRevision,
              clientId,
              content: mutation.content,
              mutationId: mutation.mutationId,
              scratchpadId: draft.scratchpadId,
              sessionId: draft.sessionId,
              type: "save",
              v: 1,
            },
          );
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "mutation_mismatch") throw error;
          const replacement = { ...mutation, mutationId: this.makeId() };
          const updated = {
            ...draft,
            ...(draft.inFlight ? { inFlight: replacement } : { pending: replacement }),
          };
          await this.repository.saveDraft(updated);
          this.replace(updated);
          continue;
        }
        await this.finish(draft, mutation.mutationId, result, onConflict);
      }
    } finally {
      this.replaying = false;
    }
  }

  private async finish(
    draft: DraftRecord,
    mutationId: string,
    result: AckEnvelope | ConflictEnvelope,
    onConflict: () => Promise<void>,
  ): Promise<void> {
    if (result.type === "ack") {
      if (draft.inFlight?.mutationId === mutationId && draft.pending) {
        const updated: DraftRecord = {
          ...draft,
          baseRevision: result.revision,
          content: draft.pending.content,
          inFlight: undefined,
        };
        await this.repository.saveDraft(updated);
        this.replace(updated);
      } else {
        await this.repository.deleteDraft(draft.sessionId);
        this.remove(draft.sessionId);
      }
      return;
    }

    await this.repository.saveConflict(result);
    if (draft.inFlight?.mutationId === mutationId && draft.pending) {
      const blocked: DraftRecord = {
        ...draft,
        baseRevision: result.serverRevision,
        blockedByConflictId: result.conflictId,
        content: draft.pending.content,
        inFlight: undefined,
      };
      await this.repository.saveDraft(blocked);
      this.replace(blocked);
    } else {
      await this.repository.deleteDraft(draft.sessionId);
      this.remove(draft.sessionId);
    }
    await onConflict();
  }

  replace(draft: DraftRecord): void {
    this.drafts = [
      ...this.drafts.filter((value) => value.sessionId !== draft.sessionId),
      draft,
    ].toSorted(
      (left, right) =>
        left.updatedAt - right.updatedAt || left.sessionId.localeCompare(right.sessionId),
    );
  }

  private remove(sessionId: string): void {
    this.drafts = this.drafts.filter((draft) => draft.sessionId !== sessionId);
  }
}
