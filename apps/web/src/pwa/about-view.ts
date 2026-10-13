import { buildLabel, runningBuild, type BuildInfo } from "./build-info.js";

export function aboutView(
  editor: HTMLTextAreaElement,
  beforeReload: () => Promise<void>,
): HTMLElement {
  const footer = document.createElement("footer");
  footer.className = "about-footer";
  const toggle = button("About Jotter");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "about-jotter");
  const panel = document.createElement("section");
  panel.id = "about-jotter";
  panel.className = "about-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "About Jotter");
  const purpose = document.createElement("p");
  purpose.textContent = "One place to write quickly and find the same text across devices.";
  const running = identityDetails("Running", runningBuild);
  const deployed = document.createElement("div");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const check = button("Check again");
  const reload = button("Reload");
  reload.hidden = true;
  reload.addEventListener("click", () => {
    reload.disabled = true;
    void beforeReload()
      .then(() => location.reload())
      .catch(() => {
        status.textContent =
          "Couldn’t save your edits on this device. Keep this page open and copy your text before reloading.";
        reload.disabled = false;
      });
  });
  const close = button("Back to writing");
  const actions = document.createElement("div");
  actions.className = "about-actions";
  actions.append(check, reload, close);
  panel.append(purpose, running, deployed, status, actions);
  footer.append(toggle, panel);

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
        ? "A different build is deployed. Your edits stay saved on this device when you reload."
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
  const hide = () => {
    request?.abort();
    request = undefined;
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    editor.focus({ preventScroll: true });
  };
  toggle.addEventListener("click", () => {
    if (!panel.hidden) {
      hide();
      return;
    }
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    void checkDeployed();
  });
  close.addEventListener("click", hide);
  check.addEventListener("click", () => void checkDeployed());
  footer.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      hide();
    }
  });
  return footer;
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
