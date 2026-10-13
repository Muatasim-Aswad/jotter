import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "apps/web/package.json"));
const { chromium, expect } = require("@playwright/test");
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const origin = `http://127.0.0.1:${port}`;
const data = await mkdtemp(join(tmpdir(), "jotter-screenshot-"));
const server = spawn(join(root, ".build/jotter"), [], {
  cwd: root,
  env: {
    ...process.env,
    AUTH_DISABLED: "false",
    JOTTER_ENV: "development",
    JOTTER_DATA_DIR: data,
    JOTTER_LISTEN_ADDR: `127.0.0.1:${port}`,
    JOTTER_PUBLIC_ORIGIN: origin,
  },
  stdio: "ignore",
});
let spawnError;
const stopped = once(server, "exit").catch((error) => {
  spawnError = error;
});
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (server.exitCode !== null) throw new Error("Screenshot server exited before readiness.");
    try {
      ready = (await fetch(`${origin}/health/ready`)).ok;
    } catch {}
    if (ready) break;
    await delay(100);
  }
  if (!ready) throw new Error("Screenshot server did not become ready.");
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(origin);
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  await editor.fill(`Groceries
- Milk, eggs, coffee

Remember
- Add Friday's appointment to agenda

For later
* The quiet courtyard I passed today`);
  await editor.blur();
  await expect(editor).toHaveAttribute("data-acknowledged-revision", /[1-9]\d*/u);
  await mkdir(join(root, "docs/images"), { recursive: true });
  await expect(page.getByRole("button", { name: "About Jotter" })).toBeVisible();
  await page.screenshot({ path: join(root, "docs/images/editor.png") });
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await stopped;
  await rm(data, { recursive: true, force: true });
}
