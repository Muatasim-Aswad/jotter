import { describe, expect, it } from "vitest";
import { reconnectDelay, websocketURL } from "./websocket-transport.js";

describe("WebSocket reconnect policy", () => {
  it("reconnects immediately first and then applies bounded jittered backoff", () => {
    expect(reconnectDelay(0, () => 0.5)).toBe(0);
    expect(reconnectDelay(1, () => 0.5)).toBe(250);
    expect(reconnectDelay(2, () => 0.5)).toBe(500);
    expect(reconnectDelay(20, () => 1)).toBe(12_000);
  });

  it("uses the page origin and secure WebSockets for HTTPS", () => {
    expect(websocketURL({ href: "https://jotter.test/editor" } as Location)).toBe(
      "wss://jotter.test/ws",
    );
    expect(websocketURL({ href: "http://127.0.0.1:4173/" } as Location)).toBe(
      "ws://127.0.0.1:4173/ws",
    );
  });
});
