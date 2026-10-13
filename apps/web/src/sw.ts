import { contentByteLength, MAX_CONTENT_BYTES } from "@jotter/protocol/content";
import { openJotterDatabase } from "./storage/database.js";
import type { ShareInboxRecord } from "./storage/models.js";

interface PrecacheEntry {
  revision: string | null;
  url: string;
}

interface WorkerExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface WorkerFetchEvent extends WorkerExtendableEvent {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

interface WorkerScope {
  readonly __WB_MANIFEST: PrecacheEntry[];
  readonly clients: { claim(): Promise<void> };
  readonly location: Location;
  readonly registration: { scope: string };
  skipWaiting(): Promise<void>;
  addEventListener(
    type: "activate" | "install",
    listener: (event: WorkerExtendableEvent) => void,
  ): void;
  addEventListener(type: "fetch", listener: (event: WorkerFetchEvent) => void): void;
}

const serviceWorker = globalThis as unknown as WorkerScope;
const entries = (self as unknown as WorkerScope).__WB_MANIFEST;
const cacheName = `jotter-static-${manifestHash(entries)}`;
const assetUrls = new Set(entries.map((entry) => precacheUrl(entry.url)));
const shellUrl = new URL("./", serviceWorker.registration.scope).href;

serviceWorker.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(cacheName)
      .then((cache) =>
        cache.addAll([...assetUrls].map((url) => new Request(url, { cache: "reload" }))),
      )
      .then(() => serviceWorker.skipWaiting()),
  );
});

// Taking over immediately is safe only while the build stays a single eagerly
// loaded bundle. Deleting the previous precache below strips every earlier
// hashed asset, and the build also clears the output directory, so a page left
// running on the old bundle would 404 on anything it fetched afterwards.
// Introducing dynamic import() or code splitting invalidates that assumption.
serviceWorker.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("jotter-static-") && name !== cacheName)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => serviceWorker.clients.claim()),
  );
});

serviceWorker.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method === "POST" &&
    url.origin === serviceWorker.location.origin &&
    url.pathname === "/share"
  ) {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.method !== "GET" || url.origin !== serviceWorker.location.origin) return;
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname === "/ws" ||
    url.pathname === "/version.json" ||
    url.pathname.startsWith("/health")
  ) {
    return;
  }
  if (event.request.mode === "navigate" && shellUrl) {
    event.respondWith(
      caches
        .open(cacheName)
        .then((cache) => cache.match(shellUrl))
        .then((response) => response ?? fetch(event.request)),
    );
    return;
  }
  if (assetUrls.has(url.href)) {
    event.respondWith(
      caches
        .open(cacheName)
        .then((cache) => cache.match(event.request))
        .then((response) => response ?? fetch(event.request)),
    );
  }
});

async function receiveShare(request: Request): Promise<Response> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/x-www-form-urlencoded")
  ) {
    return new Response("Share payload must be URL encoded.", { status: 415 });
  }
  try {
    const form = await request.formData();
    const title = readField(form, "title");
    const text = readField(form, "text");
    const url = readField(form, "url");
    if (title === "" && text === "" && url === "") {
      return new Response("Share payload is empty.", { status: 400 });
    }
    const record: ShareInboxRecord = {
      createdAt: Date.now(),
      id: crypto.randomUUID(),
      state: "pending",
      ...(text === "" ? {} : { text }),
      ...(title === "" ? {} : { title }),
      ...(url === "" ? {} : { url }),
    };
    const database = await openJotterDatabase();
    try {
      await database.add("share-inbox", record);
    } finally {
      database.close();
    }
    return new Response(null, { headers: { Location: "/" }, status: 303 });
  } catch (error) {
    const status = error instanceof ShareFieldTooLargeError ? 413 : 400;
    return new Response(
      status === 413 ? "Share field exceeds the 1 MiB limit." : "Share payload is invalid.",
      { status },
    );
  }
}

function readField(form: FormData, name: string): string {
  const values = form.getAll(name);
  if (values.length > 1 || (values[0] !== undefined && typeof values[0] !== "string")) {
    throw new TypeError(`Invalid ${name} field.`);
  }
  const value = (values[0] as string | undefined) ?? "";
  if (contentByteLength(value) > MAX_CONTENT_BYTES) throw new ShareFieldTooLargeError();
  return value;
}

class ShareFieldTooLargeError extends Error {}

function manifestHash(manifest: readonly PrecacheEntry[]): string {
  let hash = 2_166_136_261;
  const value = manifest.map((entry) => `${entry.url}:${entry.revision ?? ""}`).join("|");
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16);
}

function precacheUrl(path: string): string {
  const url = new URL(path, serviceWorker.registration.scope);
  return url.pathname.endsWith("/index.html")
    ? new URL("./", serviceWorker.registration.scope).href
    : url.href;
}
