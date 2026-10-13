export async function registerPwa(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    void navigator.storage?.persist?.().catch(() => false);
  } catch {
    // The editor and local persistence remain usable when registration is unavailable.
  }
}
