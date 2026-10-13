import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Plugin } from "vite";

interface BuildInfo {
  readonly version: string | null;
  readonly revision: string;
  readonly committedAt: string | null;
  readonly builtAt: string;
}

export function buildInfo(): Plugin {
  let json = "";
  return {
    name: "build-info",
    config(config) {
      const info = readBuildInfo(config.root ?? process.cwd());
      json = `${JSON.stringify(info, null, 2)}\n`;
      return { define: { __BUILD_INFO__: JSON.stringify(info) } };
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/version.json") {
          next();
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.end(json);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: json });
    },
  };
}

export function readBuildInfo(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): BuildInfo {
  const manifest = JSON.parse(readFileSync(resolve(root, "../../package.json"), "utf8")) as {
    version: string;
  };
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Invalid product version");
  const explicit = ["APP_REVISION", "APP_COMMIT_TIME", "APP_BUILD_TIME"].map(
    (name) => environment[name] || null,
  );
  const repository = resolve(root, "../..");
  const hasSource = git(root, "rev-parse", "--show-toplevel") === repository;
  const clean = hasSource && git(root, "status", "--porcelain", "--untracked-files=normal") === "";
  const head = hasSource ? git(root, "rev-parse", "HEAD") : null;
  const commit = hasSource ? git(root, "show", "--no-patch", "--format=%cI", "HEAD") : null;
  let revision = "dev";
  let committedAt: string | null = null;
  let builtAt: string;
  if (explicit.some((value) => value !== null)) {
    const [suppliedRevision, suppliedCommit, suppliedBuild] = explicit;
    if (
      !suppliedRevision ||
      !/^[a-f0-9]{40}$/.test(suppliedRevision) ||
      !suppliedCommit ||
      !suppliedBuild
    ) {
      throw new Error(
        "Explicit identity requires APP_REVISION, APP_COMMIT_TIME and APP_BUILD_TIME",
      );
    }
    committedAt = timestamp(suppliedCommit);
    builtAt = timestamp(suppliedBuild);
    if (hasSource && !clean) {
      committedAt = null;
    } else {
      if (
        hasSource &&
        (suppliedRevision !== head || !commit || committedAt !== timestamp(commit))
      ) {
        throw new Error("Explicit identity does not match local source");
      }
      revision = suppliedRevision;
    }
  } else {
    if (clean && head && commit) {
      revision = head;
      committedAt = timestamp(commit);
    }
    builtAt = committedAt ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");
  }
  if (environment.SOURCE_DATE_EPOCH !== undefined) {
    if (!/^\d+$/.test(environment.SOURCE_DATE_EPOCH)) throw new Error("Invalid SOURCE_DATE_EPOCH");
    const deterministic = timestamp(Number(environment.SOURCE_DATE_EPOCH) * 1000);
    if (committedAt !== null && deterministic !== committedAt) {
      throw new Error("SOURCE_DATE_EPOCH must equal the commit time");
    }
    if (explicit.some((value) => value !== null) && deterministic !== builtAt) {
      throw new Error("APP_BUILD_TIME must equal SOURCE_DATE_EPOCH");
    }
    builtAt = deterministic;
  }
  return { version: manifest.version, revision, committedAt, builtAt };
}

function timestamp(value: string | number): string {
  if (
    typeof value === "string" &&
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new Error("Invalid build timestamp");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid build timestamp");
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

function git(root: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}
