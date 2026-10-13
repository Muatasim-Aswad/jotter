import type { StoredConflict } from "../../storage/models.js";

export interface ConflictHandlers {
  onResolve: (content: string) => void;
}

export class ConflictView {
  private error?: HTMLElement;

  constructor(private readonly root: HTMLElement) {}

  mount(conflict: StoredConflict, handlers: ConflictHandlers): void {
    this.root.replaceChildren();
    const style = document.createElement("style");
    style.textContent = conflictStyles;
    const screen = document.createElement("section");
    screen.className = "conflict-screen";
    screen.setAttribute("aria-labelledby", "conflict-title");
    screen.dataset.conflictId = conflict.conflictId;

    const title = document.createElement("h1");
    title.id = "conflict-title";
    title.textContent = "Choose which version to keep";
    const explanation = document.createElement("p");
    explanation.textContent =
      "This device and the server changed independently. Nothing has been discarded.";

    const tabs = document.createElement("div");
    tabs.className = "conflict-tabs";
    const localTab = button("This device", "conflict-tab");
    const serverTab = button("Server", "conflict-tab");
    tabs.append(localTab, serverTab);

    const panels = document.createElement("div");
    panels.className = "conflict-panels";
    const localPanel = panel(
      "This device",
      conflict.submittedContent,
      conflict.baseRevision,
      conflict.createdAt,
    );
    const serverPanel = panel(
      "Server",
      conflict.serverContent,
      conflict.serverRevision,
      conflict.createdAt,
    );
    localPanel.classList.add("active");
    panels.append(localPanel, serverPanel);
    localTab.addEventListener("click", () => selectPanel(localPanel, serverPanel));
    serverTab.addEventListener("click", () => selectPanel(serverPanel, localPanel));

    const actions = document.createElement("div");
    actions.className = "conflict-actions";
    const useLocal = button("Use this device", "conflict-action");
    const useServer = button("Use server", "conflict-action");
    const edit = button("Edit resolution", "conflict-action");
    actions.append(useLocal, useServer, edit);

    const editor = document.createElement("div");
    editor.className = "conflict-editor";
    editor.hidden = true;
    const textarea = document.createElement("textarea");
    textarea.setAttribute("aria-label", "Edit conflict resolution");
    textarea.value = conflict.proposedContent ?? conflict.submittedContent;
    const commit = button("Use edited resolution", "conflict-action conflict-primary");
    editor.append(textarea, commit);

    this.error = document.createElement("p");
    this.error.className = "conflict-error";
    this.error.setAttribute("role", "alert");
    this.error.hidden = true;

    useLocal.addEventListener("click", () => handlers.onResolve(conflict.submittedContent));
    useServer.addEventListener("click", () => handlers.onResolve(conflict.serverContent));
    edit.addEventListener("click", () => {
      editor.hidden = false;
      textarea.focus();
    });
    commit.addEventListener("click", () => handlers.onResolve(textarea.value));

    screen.append(title, explanation, tabs, panels, actions, editor, this.error);
    this.root.append(style, screen);
    this.root.dataset.ready = "true";
  }

  showError(message: string): void {
    if (!this.error) return;
    this.error.textContent = message;
    this.error.hidden = false;
  }
}

function panel(label: string, content: string, revision: number, createdAt: string): HTMLElement {
  const element = document.createElement("article");
  element.className = "conflict-panel";
  const heading = document.createElement("h2");
  heading.textContent = label;
  const metadata = document.createElement("p");
  metadata.className = "conflict-meta";
  metadata.textContent = `Revision ${revision} · ${formatConflictTime(createdAt)}`;
  const text = document.createElement("pre");
  text.textContent = content;
  element.append(heading, metadata, text);
  return element;
}

function button(label: string, className: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  return element;
}

function selectPanel(active: HTMLElement, inactive: HTMLElement): void {
  active.classList.add("active");
  inactive.classList.remove("active");
}

export function formatConflictTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

const conflictStyles = `
  .conflict-screen { box-sizing: border-box; width: min(100%, 76rem); min-height: 100dvh; margin: 0 auto; padding: max(2rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(2rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left)); color: #cfccc4; font-family: system-ui, sans-serif; }
  .conflict-screen h1 { margin: 0 0 .5rem; font-size: clamp(1.4rem, 3vw, 2rem); }
  .conflict-screen > p { color: #c8c3b9; }
  .conflict-panels { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin-block: 1.5rem; }
  .conflict-panel { min-width: 0; border: 1px solid #45433f; border-radius: .5rem; background: #171819; }
  .conflict-panel h2, .conflict-meta { margin: 0; padding: .8rem 1rem 0; }
  .conflict-meta { color: #aaa59b; font-size: .8rem; }
  .conflict-panel pre { min-height: 14rem; max-height: 48vh; margin: 0; padding: 1rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 1rem/1.55 ui-monospace, monospace; }
  .conflict-actions, .conflict-tabs { display: flex; flex-wrap: wrap; gap: .65rem; }
  .conflict-action, .conflict-tab { border: 1px solid #706b61; border-radius: .35rem; padding: .7rem .9rem; background: #242526; color: #f5f1e8; font: 600 .9rem/1 system-ui, sans-serif; }
  .conflict-action:focus-visible, .conflict-tab:focus-visible, .conflict-editor textarea:focus { outline: 2px solid #f6bd60; outline-offset: 2px; }
  .conflict-primary { border-color: #bc8736; background: #5a3f18; }
  .conflict-tabs { display: none; }
  .conflict-editor { margin-top: 1rem; }
  .conflict-editor textarea { box-sizing: border-box; display: block; width: 100%; min-height: 12rem; margin-bottom: .65rem; border: 1px solid #706b61; border-radius: .35rem; padding: .8rem; background: #151719; color: #cfccc4; font: 1rem/1.55 ui-monospace, monospace; }
  .conflict-error { color: #ffb4a5 !important; }
  @media (max-width: 640px), (pointer: coarse) {
    .conflict-tabs { display: flex; }
    .conflict-panels { display: block; }
    .conflict-panel:not(.active) { display: none; }
    .conflict-panel pre { max-height: 42vh; }
  }
`;
