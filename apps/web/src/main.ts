import { createEditorApp } from "./app/bootstrap.js";
import { announceBuild, takeUpdateNotice } from "./pwa/build-info.js";
import { registerPwa } from "./pwa/register.js";
import { showUpdateToast } from "./pwa/update-toast.js";
import "./styles/editor.css";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Application root is missing.");

const controller = createEditorApp(root);
void registerPwa();
announceBuild();
const update = takeUpdateNotice(localStorage);
if (update) showUpdateToast(update);
void controller.start();
window.addEventListener("unload", () => controller.stop(), { once: true });
