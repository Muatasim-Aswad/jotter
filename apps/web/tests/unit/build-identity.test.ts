import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBuildInfo } from "../../build-info.js";

const temporary: string[] = [];
afterEach(() =>
  temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "jotter-identity-"));
  temporary.push(directory);
  const root = join(directory, "apps/web");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "1.0.0" }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_DATE: "2026-10-13T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-10-13T00:00:00Z",
      },
    });
  return { root, directory, git };
}

describe("artifact identity", () => {
  it("uses the root version and honest dev identity without source metadata", () => {
    const { root } = fixture();
    expect(readBuildInfo(root, {})).toMatchObject({
      version: "1.0.0",
      revision: "dev",
      committedAt: null,
    });
  });
  it("uses a clean commit and commit-derived build time; tracked and untracked changes report dev", () => {
    const { root, directory, git } = fixture();
    git("init");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    );
    const clean = readBuildInfo(root, { SOURCE_DATE_EPOCH: "1791849600" });
    expect(clean).toMatchObject({
      version: "1.0.0",
      revision: git("rev-parse", "HEAD").toString().trim(),
      committedAt: "2026-10-13T00:00:00Z",
      builtAt: "2026-10-13T00:00:00Z",
    });
    writeFileSync(join(directory, "extra.ts"), "untracked");
    expect(readBuildInfo(root, {}).revision).toBe("dev");
    expect(
      readBuildInfo(root, {
        APP_REVISION: clean.revision,
        APP_COMMIT_TIME: clean.committedAt!,
        APP_BUILD_TIME: clean.builtAt,
      }),
    ).toMatchObject({ revision: "dev", committedAt: null });
    rmSync(join(directory, "extra.ts"));
    writeFileSync(join(root, "package.json"), "{}");
    expect(readBuildInfo(root, {})).toMatchObject({ revision: "dev", committedAt: null });
  });
  it("requires complete explicit container metadata and consistent deterministic timestamps", () => {
    const { root } = fixture();
    const environment = {
      APP_REVISION: "a".repeat(40),
      APP_COMMIT_TIME: "2026-10-13T02:00:00+02:00",
      APP_BUILD_TIME: "2026-10-13T00:00:00Z",
      SOURCE_DATE_EPOCH: "1791849600",
    };
    expect(readBuildInfo(root, environment)).toMatchObject({
      revision: "a".repeat(40),
      committedAt: "2026-10-13T00:00:00Z",
      builtAt: "2026-10-13T00:00:00Z",
    });
    expect(() => readBuildInfo(root, { APP_REVISION: "a".repeat(40) })).toThrow(
      "Explicit identity",
    );
    expect(() => readBuildInfo(root, { ...environment, SOURCE_DATE_EPOCH: "invalid" })).toThrow(
      "SOURCE_DATE_EPOCH",
    );
    expect(() =>
      readBuildInfo(root, { ...environment, APP_BUILD_TIME: "2026-10-13T01:00:00Z" }),
    ).toThrow("APP_BUILD_TIME");
    expect(() => readBuildInfo(root, { ...environment, APP_COMMIT_TIME: "invalid" })).toThrow(
      "timestamp",
    );
  });
});
