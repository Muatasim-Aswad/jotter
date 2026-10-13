import { decodeHttp, type ConflictRecord, type ScratchpadState } from "@jotter/protocol";

export interface BootstrapPayload {
  conflicts: ConflictRecord[];
  scratchpad: ScratchpadState;
}

export class HttpTransportError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "HttpTransportError";
  }
}

export class HttpTransport {
  constructor(private readonly request: typeof fetch = (...arguments_) => fetch(...arguments_)) {}

  async bootstrap(): Promise<BootstrapPayload> {
    const response = await this.request("/api/v1/bootstrap", {
      headers: { Accept: "application/json" },
    });
    const body = await response.json();
    if (!response.ok) throw httpError(response.status, body);
    return decodeHttp("BootstrapResponse", body);
  }

  async resolveConflict(
    conflictId: string,
    content: string,
    baseRevision: number,
  ): Promise<ScratchpadState> {
    const response = await this.request(
      `/api/v1/conflicts/${encodeURIComponent(conflictId)}/resolve`,
      {
        body: JSON.stringify({ baseRevision, content }),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      },
    );
    const body = await response.json();
    if (!response.ok) throw httpError(response.status, body);
    return decodeHttp("ResolveResponse", body);
  }
}

function httpError(status: number, value: unknown): HttpTransportError {
  try {
    const body = decodeHttp("HttpErrorResponse", value).error;
    if (body.status !== status) throw new Error("HTTP status mismatch");
    return new HttpTransportError(body.code, status, body.message, body.request_id);
  } catch {
    return new HttpTransportError("internal_error", status, "The server request failed.");
  }
}
