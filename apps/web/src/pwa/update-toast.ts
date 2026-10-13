import { buildLabel, type BuildInfo } from "./build-info.js";

const shownMs = 5000;

/**
 * Says once that a new build is running. It floats clear of the text, never
 * takes focus, and leaves by itself or when pressed.
 */
export function showUpdateToast(build: BuildInfo, parent: HTMLElement = document.body): void {
  const toast = document.createElement("div");
  toast.className = "update-toast";
  toast.setAttribute("role", "status");
  toast.textContent = `Updated to ${buildLabel(build)}`;
  const remove = () => toast.remove();
  toast.addEventListener("click", remove, { once: true });
  parent.append(toast);
  window.setTimeout(remove, shownMs);
}
