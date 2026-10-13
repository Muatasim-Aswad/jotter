import { buildLabel, runningBuild, type BuildInfo } from "./build-info.js";

export function aboutView(): HTMLElement {
  const panel = document.createElement("main");
  panel.className = "about-page";
  panel.setAttribute("aria-label", "About Jotter");
  const title = document.createElement("h1");
  title.textContent = "About Jotter";
  const purpose = document.createElement("p");
  purpose.textContent = "One place to write quickly and find the same text across devices.";
  const running = identityDetails("Running", runningBuild);
  const deployed = document.createElement("div");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const check = button("Check again");
  const reload = button("Reload");
  reload.hidden = true;
  reload.addEventListener("click", () => location.reload());
  const back = document.createElement("a");
  back.href = "/";
  back.textContent = "Back to writing";
  const actions = document.createElement("div");
  actions.className = "about-actions";
  actions.append(check, reload, back);
  panel.append(title, purpose, running, deployed, status, actions);

  let request: AbortController | undefined;
  const checkDeployed = async () => {
    request?.abort();
    const current = new AbortController();
    request = current;
    const timeout = window.setTimeout(() => current.abort(), 10_000);
    status.textContent = "Checking deployed build…";
    deployed.replaceChildren();
    reload.hidden = true;
    check.disabled = true;
    try {
      const response = await fetch("/version.json", { cache: "no-store", signal: current.signal });
      if (!response.ok) throw new Error("Build check failed");
      const build = parseBuildInfo(await response.json());
      if (request !== current) return;
      deployed.append(identityDetails("Deployed", build));
      const different = JSON.stringify(build) !== JSON.stringify(runningBuild);
      reload.hidden = !different;
      status.textContent = different
        ? "A different build is deployed. Reload to use it."
        : "You’re running the deployed build.";
    } catch {
      if (request === current)
        status.textContent =
          "Couldn’t check the deployed build. Check your connection and try again.";
    } finally {
      window.clearTimeout(timeout);
      if (request === current) check.disabled = false;
    }
  };
  check.addEventListener("click", () => void checkDeployed());
  window.addEventListener("pagehide", () => request?.abort(), { once: true });
  void checkDeployed();
  return panel;
}

function button(label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  return element;
}

function identityDetails(label: string, build: BuildInfo): HTMLElement {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = `${label}: ${buildLabel(build)}`;
  const metadata = document.createElement("p");
  metadata.className = "build-details";
  metadata.textContent = `Revision: ${build.revision}\nCommitted: ${build.committedAt ?? "Unverified source"}\nBuilt: ${build.builtAt}`;
  details.append(summary, metadata);
  return details;
}

export function parseBuildInfo(value: unknown): BuildInfo {
  if (typeof value !== "object" || value === null) throw new Error("Invalid build identity");
  const build = value as Record<string, unknown>;
  if (
    (build.version !== null && typeof build.version !== "string") ||
    typeof build.revision !== "string" ||
    build.revision === "" ||
    (build.committedAt !== null && typeof build.committedAt !== "string") ||
    typeof build.builtAt !== "string" ||
    !Number.isFinite(Date.parse(build.builtAt)) ||
    (typeof build.committedAt === "string" && !Number.isFinite(Date.parse(build.committedAt)))
  )
    throw new Error("Invalid build identity");
  return {
    version: build.version,
    revision: build.revision,
    committedAt: build.committedAt,
    builtAt: build.builtAt,
  } as BuildInfo;
}
