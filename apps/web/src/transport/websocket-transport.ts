import {
  decodeEnvelope,
  encodeEnvelope,
  normalizeContent,
  type AckEnvelope,
  type ConflictEnvelope,
  type Envelope,
  type ErrorEnvelope,
  type HelloEnvelope,
  type SaveEnvelope,
} from "@jotter/protocol";

const MAX_RECONNECT_MILLISECONDS = 10_000;
const REPLAY_TIMEOUT_MILLISECONDS = 10_000;

export interface WebSocketTransportOptions {
  getHello: () => HelloEnvelope;
  onConnectivity: (connected: boolean) => void;
  onEnvelope: (envelope: Exclude<Envelope, HelloEnvelope | SaveEnvelope>) => void;
  random?: () => number;
  socketFactory?: (url: string) => WebSocket;
  url?: string;
}

export class WebSocketTransport {
  private attempt = 0;
  private connected?: boolean;
  private reconnectTimer?: number;
  private socket?: WebSocket;
  private stopped = true;

  constructor(private readonly options: WebSocketTransportOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "client stopped");
    this.socket = undefined;
    this.setConnected(false);
  }

  reconnectNow(): void {
    if (this.stopped) return;
    this.setConnected(false);
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = undefined;
    this.connect();
  }

  send(save: SaveEnvelope): boolean {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(encodeEnvelope(save));
    return true;
  }

  private connect(): void {
    if (this.stopped || (this.socket && this.socket.readyState < WebSocket.CLOSING)) return;
    const factory = this.options.socketFactory ?? ((url: string) => new WebSocket(url));
    const socket = factory(this.options.url ?? websocketURL());
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (socket !== this.socket || this.stopped) return;
      socket.send(encodeEnvelope(this.options.getHello()));
    });
    socket.addEventListener("message", (event) => {
      if (socket !== this.socket || typeof event.data !== "string") return;
      try {
        const envelope = decodeEnvelope(event.data);
        if (envelope.type === "hello" || envelope.type === "save") return;
        if (envelope.type === "state") {
          this.attempt = 0;
          this.setConnected(true);
        }
        this.options.onEnvelope(envelope);
      } catch {
        socket.close(1002, "invalid server message");
      }
    });
    socket.addEventListener("close", () => {
      if (socket !== this.socket) return;
      this.socket = undefined;
      this.setConnected(false);
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => socket.close());
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = reconnectDelay(this.attempt++, this.options.random ?? Math.random);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.options.onConnectivity(connected);
  }
}

export function reconnectDelay(attempt: number, random: () => number): number {
  if (attempt === 0) return 0;
  const base = Math.min(MAX_RECONNECT_MILLISECONDS, 250 * 2 ** (attempt - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}

export function websocketURL(locationValue: Location = location): string {
  const url = new URL("/ws", locationValue.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export async function replayMutation(
  hello: HelloEnvelope,
  save: SaveEnvelope,
  url = websocketURL(),
  socketFactory: (url: string) => WebSocket = (value) => new WebSocket(value),
): Promise<AckEnvelope | ConflictEnvelope> {
  return new Promise((resolve, reject) => {
    const socket = socketFactory(url);
    const timeout = window.setTimeout(() => {
      socket.close();
      reject(new Error("Timed out while replaying an offline draft."));
    }, REPLAY_TIMEOUT_MILLISECONDS);
    let receivedState = false;
    const finish = (result: AckEnvelope | ConflictEnvelope): void => {
      window.clearTimeout(timeout);
      socket.close(1000, "replay complete");
      resolve(result);
    };
    socket.addEventListener("open", () => socket.send(encodeEnvelope(hello)));
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let envelope: Envelope;
      try {
        envelope = decodeEnvelope(event.data);
      } catch (error) {
        reject(error);
        return;
      }
      if (envelope.type === "state") {
        receivedState = true;
        const existing = envelope.conflicts?.find(
          (conflict) => conflict.mutationId === save.mutationId,
        );
        if (existing) {
          if (
            existing.submittedContent !== normalizeContent(save.content) ||
            existing.baseRevision !== save.baseRevision ||
            existing.clientId !== save.clientId ||
            existing.sessionId !== save.sessionId
          ) {
            window.clearTimeout(timeout);
            socket.close();
            reject(
              transportError({
                v: 1,
                type: "error",
                code: "mutation_mismatch",
                message: "Mutation identity does not match the original request.",
              }),
            );
            return;
          }
          finish({ type: "conflict", v: 1, ...existing });
          return;
        }
        socket.send(encodeEnvelope(save));
        return;
      }
      if (!receivedState) return;
      if (envelope.type === "ack" && envelope.mutationId === save.mutationId) finish(envelope);
      if (envelope.type === "conflict" && envelope.mutationId === save.mutationId) finish(envelope);
      if (envelope.type === "error") {
        window.clearTimeout(timeout);
        socket.close();
        reject(transportError(envelope));
      }
    });
    socket.addEventListener("close", (event) => {
      if (event.code === 1000) return;
      window.clearTimeout(timeout);
      reject(new Error("Connection closed while replaying an offline draft."));
    });
    socket.addEventListener("error", () => socket.close());
  });
}

function transportError(envelope: ErrorEnvelope): Error {
  const error = new Error(envelope.message);
  error.name = envelope.code;
  return error;
}
