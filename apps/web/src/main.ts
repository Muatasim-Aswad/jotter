import { createEditorApp } from "./app/bootstrap.js";
import { aboutView } from "./pwa/about-view.js";
import { announceBuild, takeUpdateNotice } from "./pwa/build-info.js";
import { registerPwa } from "./pwa/register.js";
import { showUpdateToast } from "./pwa/update-toast.js";
import "./styles/editor.css";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Application root is missing.");

void registerPwa();
announceBuild();
if (location.pathname === "/about" || location.pathname === "/about/") {
  document.title = "About Jotter";
  root.append(aboutView());
} else {
  const controller = createEditorApp(root);
  const update = takeUpdateNotice(localStorage);
  if (update) showUpdateToast(update);
  void controller.start();
  window.addEventListener("unload", () => controller.stop(), { once: true });
}
