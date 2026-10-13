import { expect, it } from "vitest";
import { HttpTransport, HttpTransportError } from "./http-transport.js";

it("retains a validated request reference on server errors", async () => {
  const transport = new HttpTransport(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            status: 409,
            code: "stale_revision",
            message: "scratchpad changed",
            request_id: "request-1",
          },
        }),
        { status: 409 },
      ),
  );
  await expect(transport.resolveConflict("conflict", "local", 1)).rejects.toMatchObject({
    code: "stale_revision",
    requestId: "request-1",
    status: 409,
  });
});

it("replaces malformed or status-mismatched errors with a safe fallback", async () => {
  const transport = new HttpTransport(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            status: 400,
            code: "invalid_state",
            message: "private server detail",
            request_id: "request-1",
          },
        }),
        { status: 500 },
      ),
  );
  await expect(transport.bootstrap()).rejects.toEqual(
    new HttpTransportError("internal_error", 500, "The server request failed."),
  );
});
