import type { UiPosition } from "../../storage/models.js";

export interface EditorHandlers {
  onFlush: () => void;
  onInput: (content: string) => void;
  onPosition: (position: UiPosition) => void;
}

export class EditorView {
  private banner?: HTMLDivElement;
  private textarea?: HTMLTextAreaElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: EditorHandlers,
  ) {}

  mount(content: string, position: UiPosition | undefined, autofocus: boolean): void {
    this.root.replaceChildren();
    this.banner = document.createElement("div");
    this.banner.className = "error-banner";
    this.banner.setAttribute("role", "alert");
    this.banner.hidden = true;

    this.textarea = document.createElement("textarea");
    this.textarea.className = "editor";
    this.textarea.value = content;
    this.textarea.setAttribute("aria-label", "Scratchpad");
    this.textarea.setAttribute("autocapitalize", "sentences");
    this.textarea.setAttribute("autocomplete", "off");
    this.textarea.spellcheck = true;
    this.textarea.wrap = "soft";
    this.textarea.addEventListener("input", () =>
      this.handlers.onInput(this.textarea?.value ?? ""),
    );
    this.textarea.addEventListener("blur", this.handlers.onFlush);
    this.textarea.addEventListener("select", () => this.emitPosition());
    this.textarea.addEventListener("scroll", () => this.emitPosition(), { passive: true });

    this.root.append(this.banner, this.textarea);
    this.root.dataset.ready = "true";
    requestAnimationFrame(() => {
      if (!this.textarea) return;
      if (position) {
        this.textarea.setSelectionRange(
          Math.min(position.selectionStart, content.length),
          Math.min(position.selectionEnd, content.length),
          position.selectionDirection,
        );
        this.textarea.scrollTop = position.scrollTop;
      }
      if (autofocus) {
        this.textarea.focus({ preventScroll: true });
        if (document.activeElement === this.textarea) {
          const keyboard = (navigator as Navigator & { virtualKeyboard?: { show(): void } })
            .virtualKeyboard;
          keyboard?.show();
        }
      }
    });
  }

  showFatal(message: string): void {
    this.root.replaceChildren();
    this.textarea = undefined;
    this.banner = document.createElement("div");
    this.banner.className = "error-banner fatal-error";
    this.banner.setAttribute("role", "alert");
    this.banner.textContent = message;
    this.root.append(this.banner);
    this.root.dataset.ready = "true";
  }

  showError(message: string): void {
    if (!this.banner) return;
    this.banner.textContent = message;
    this.banner.hidden = false;
  }

  clearError(): void {
    if (!this.banner) return;
    this.banner.hidden = true;
    this.banner.textContent = "";
  }

  restoreContent(content: string): void {
    if (this.textarea) this.textarea.value = content;
  }

  applyRemoteContent(content: string): void {
    if (!this.textarea || this.textarea.value === content) return;
    const focused = document.activeElement === this.textarea;
    const position = this.position();
    const mapped = mapSelection(this.textarea.value, content, position);
    this.textarea.value = content;
    this.textarea.setSelectionRange(
      mapped.selectionStart,
      mapped.selectionEnd,
      mapped.selectionDirection,
    );
    this.textarea.scrollTop = mapped.scrollTop;
    if (focused) this.textarea.focus({ preventScroll: true });
  }

  position(): UiPosition {
    if (!this.textarea) {
      return {
        id: "editor",
        scrollTop: 0,
        selectionDirection: "none",
        selectionEnd: 0,
        selectionStart: 0,
      };
    }
    return {
      id: "editor",
      scrollTop: this.textarea.scrollTop,
      selectionDirection: this.textarea.selectionDirection,
      selectionEnd: this.textarea.selectionEnd,
      selectionStart: this.textarea.selectionStart,
    };
  }

  markPersisted(): void {
    if (this.textarea) this.textarea.dataset.persisted = "true";
  }

  markAcknowledged(revision: number): void {
    if (this.textarea) this.textarea.dataset.acknowledgedRevision = String(revision);
  }

  private emitPosition(): void {
    if (this.textarea) this.handlers.onPosition(this.position());
  }
}

export function mapSelection(previous: string, next: string, position: UiPosition): UiPosition {
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }
  const mapIndex = (index: number): number => {
    if (index <= prefix) return index;
    if (index >= previous.length - suffix) return next.length - (previous.length - index);
    return Math.min(next.length - suffix, prefix + Math.max(0, next.length - prefix - suffix));
  };
  return {
    ...position,
    selectionEnd: mapIndex(position.selectionEnd),
    selectionStart: mapIndex(position.selectionStart),
  };
}
