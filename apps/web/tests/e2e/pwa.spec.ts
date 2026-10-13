import { expect, test, type Page } from "@playwright/test";

async function installAndControl(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Scratchpad" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
}

test("publishes an installable standalone manifest and activates the custom service worker", async ({
  page,
}) => {
  await installAndControl(page);
  const manifest = (await page.evaluate(async () =>
    fetch(document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href ?? "").then(
      (response) => response.json(),
    ),
  )) as {
    display: string;
    icons: Array<{ purpose: string; src: string }>;
    share_target: { action: string; enctype: string; method: string };
  };
  expect(manifest).toMatchObject({
    display: "standalone",
    share_target: {
      action: "/share",
      enctype: "application/x-www-form-urlencoded",
      method: "POST",
    },
  });
  expect(manifest.icons[0]).toMatchObject({ purpose: "any monochrome", src: "/jotter.svg" });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return registration.active?.state;
      }),
    )
    .toBe("activated");
});

test("warm-loads the durable document offline from the static-only cache", async ({
  context,
  page,
}) => {
  await installAndControl(page);
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  const content = `offline shell ${crypto.randomUUID()}`;
  await editor.fill(content);
  await expect(editor).toHaveAttribute("data-persisted", "true");

  await context.setOffline(true);
  await page.reload();
  await expect(editor).toHaveValue(content);
  await expect(page.getByRole("alert")).toContainText("Offline");
});

test("never stores API responses in the static cache", async ({ context, page }) => {
  await installAndControl(page);
  await page.evaluate(() => fetch("/api/v1/bootstrap").then((response) => response.json()));
  const cachedPaths = await page.evaluate(async () => {
    const requests = await Promise.all(
      (await caches.keys()).map(async (name) => caches.open(name).then((cache) => cache.keys())),
    );
    return requests.flat().map((cachedRequest) => new URL(cachedRequest.url).pathname);
  });
  expect(cachedPaths.some((path) => path.startsWith("/api/") || path === "/ws")).toBe(false);

  await context.setOffline(true);
  expect(
    await page.evaluate(() =>
      fetch("/api/v1/bootstrap")
        .then(() => true)
        .catch(() => false),
    ),
  ).toBe(false);
});

test("an update check does not reload or replace an active edit", async ({ page }) => {
  await installAndControl(page);
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  const content = `editing during update ${crypto.randomUUID()}`;
  await editor.fill(content);
  await expect(editor).toHaveAttribute("data-persisted", "true");
  const navigations = await page.evaluate(async () => {
    let count = 0;
    window.addEventListener("beforeunload", () => count++);
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return count;
  });
  expect(navigations).toBe(0);
  await expect(editor).toHaveValue(content);
});

test("checks uncached production identity and keeps version metadata out of the service worker cache", async ({
  page,
  request,
}) => {
  const response = await request.get("/version.json?check=1");
  expect(response.ok()).toBe(true);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.json()).toMatchObject({
    version: "1.0.0",
    revision: expect.any(String),
    builtAt: expect.any(String),
  });
  await installAndControl(page);
  await page.goto("/about");
  await expect(
    page.getByRole("status").filter({ hasText: "You’re running the deployed build." }),
  ).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const paths = await Promise.all(
        (await caches.keys()).map(async (name) =>
          (await (await caches.open(name)).keys()).map(
            (cachedRequest) => new URL(cachedRequest.url).pathname,
          ),
        ),
      );
      return paths.flat().includes("/version.json");
    }),
  ).toBe(false);
});

test("mobile About is separate and survives reloads without disturbing saved notes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installAndControl(page);
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  await expect(editor).toBeFocused();
  await expect(page.getByText("About Jotter", { exact: true })).toHaveCount(0);
  const content = `about saved edit ${crypto.randomUUID()}`;
  await editor.fill(content);
  await expect(editor).toHaveAttribute("data-persisted", "true");
  await page.goto("/about");
  const panel = page.getByRole("main", { name: "About Jotter" });
  await expect(editor).toHaveCount(0);
  await expect(panel).toContainText("You’re running the deployed build.");
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeHidden();
  const panelBox = await panel.boundingBox();
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(390);
  await page.route("**/version.json", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), revision: "b".repeat(40) } });
  });
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(panel).toContainText("A different build is deployed.");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  await page.unroute("**/version.json");
  await page.route("**/version.json", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(panel).toContainText("Couldn’t check the deployed build.");
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeHidden();
  await page.getByRole("link", { name: "Back to writing" }).click();
  await expect(editor).toHaveValue(content);
  await expect(editor).toBeFocused();
});

test("About opens directly and offline from the cached shell", async ({ context, page }) => {
  await page.goto("/about/");
  await expect(page.getByRole("heading", { name: "About Jotter" })).toBeVisible();
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "About Jotter" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Couldn’t check the deployed build.");
});
