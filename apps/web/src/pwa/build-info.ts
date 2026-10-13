/**
 * Which build is running, and a one-time notice when it is new on this device.
 * The `build-info` Vite plugin bakes the build in and serves the same record at
 * `/version.json`, which always describes what is deployed.
 */
export interface BuildInfo {
  /** `package.json` version, when the app has one. */
  readonly version: string | null;
  /** Commit SHA, or `dev` for dirty or missing source. */
  readonly revision: string;
  readonly committedAt: string | null;
  readonly builtAt: string;
}

declare const __BUILD_INFO__: BuildInfo;

export const runningBuild: BuildInfo = __BUILD_INFO__;

export const seenRevisionKey = "jotter:seen-revision";

/** `1.0.0 · a1b2c3d`, or the revision alone without a version. */
export function buildLabel(build: BuildInfo): string {
  const revision = build.revision.slice(0, 7);
  return build.version === null ? revision : `${build.version} · ${revision}`;
}

export function announceBuild(): void {
  console.info("Jotter started", runningBuild);
}

/**
 * The running build when this device last ran another one. A first visit only
 * records it, and blocked storage says nothing.
 */
export function takeUpdateNotice(storage: Pick<Storage, "getItem" | "setItem">): BuildInfo | null {
  try {
    const seen = storage.getItem(seenRevisionKey);
    storage.setItem(seenRevisionKey, runningBuild.revision);
    return seen !== null && seen !== runningBuild.revision ? runningBuild : null;
  } catch {
    return null;
  }
}
