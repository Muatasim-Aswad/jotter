/* oxlint-disable unicorn/require-post-message-target-origin -- BroadcastChannel has no target origin. */

interface ProbeMessage {
  kind: "probe";
  requestId: string;
}

interface ActiveMessage {
  kind: "active";
  requestId: string;
  sessionId: string;
}

type SessionMessage = ActiveMessage | ProbeMessage;

const CHANNEL_NAME = "jotter-active-sessions";

export class SessionCoordinator {
  private channel?: BroadcastChannel;

  async discover(waitMilliseconds = 40): Promise<ReadonlySet<string>> {
    if (!("BroadcastChannel" in globalThis)) return new Set();
    const channel = new BroadcastChannel(CHANNEL_NAME);
    const requestId = crypto.randomUUID();
    const active = new Set<string>();
    channel.addEventListener("message", (event: MessageEvent<SessionMessage>) => {
      if (event.data.kind === "active" && event.data.requestId === requestId) {
        active.add(event.data.sessionId);
      }
    });
    channel.postMessage({ kind: "probe", requestId } satisfies ProbeMessage);
    await new Promise<void>((resolve) => window.setTimeout(resolve, waitMilliseconds));
    channel.close();
    return active;
  }

  announce(sessionId: string): void {
    if (!("BroadcastChannel" in globalThis)) return;
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.addEventListener("message", (event: MessageEvent<SessionMessage>) => {
      if (event.data.kind === "probe") {
        this.channel?.postMessage({
          kind: "active",
          requestId: event.data.requestId,
          sessionId,
        } satisfies ActiveMessage);
      }
    });
  }

  close(): void {
    this.channel?.close();
  }
}
