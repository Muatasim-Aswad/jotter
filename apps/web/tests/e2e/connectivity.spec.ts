import { devices, expect, test } from "@playwright/test";

test("a warm launch shows offline when the server is unreachable despite an online network", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  await expect(editor).toBeVisible();

  await page.routeWebSocket("**/ws", (socket) => socket.close());
  await page.reload();
  await expect(editor).toBeVisible();
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await expect(page.getByRole("alert")).toContainText("Offline");
});

test("a delayed server response does not dismiss the offline banner", async ({ page }) => {
  let deliverState: (() => void) | undefined;
  await page.routeWebSocket("**/ws", (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (JSON.parse(String(message)).type === "state") {
        deliverState = () => socket.send(message);
      } else {
        socket.send(message);
      }
    });
  });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Scratchpad" })).toBeVisible();
  await expect.poll(() => Boolean(deliverState)).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
  });
  await expect(page.getByRole("alert")).toContainText("Offline");
  deliverState!();
  await page.waitForTimeout(250);
  await expect(page.getByRole("alert")).toContainText("Offline");
});

test("the offline banner persists and returns across repeated network changes", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  await editor.fill(`network changes ${crypto.randomUUID()}`);
  await expect(editor).toHaveAttribute("data-acknowledged-revision", /\d+/u);
  const banner = page.getByRole("alert");

  for (let cycle = 0; cycle < 3; cycle++) {
    await context.setOffline(true);
    await expect(banner).toContainText("Offline");
    await editor.fill(`offline cycle ${cycle} ${crypto.randomUUID()}`);
    await expect(editor).toHaveAttribute("data-persisted", "true");
    await page.waitForTimeout(400);
    await expect(banner).toContainText("Offline");
    await context.setOffline(false);
    await expect(banner).toBeHidden();
  }
});

for (const device of ["Desktop Chrome", "Pixel 7"]) {
  test(`${device} reserves writing space below the offline banner`, async ({
    browser,
    baseURL,
  }, testInfo) => {
    const context = await browser.newContext(devices[device]);
    try {
      const page = await context.newPage();
      await page.goto(baseURL ?? "http://127.0.0.1:4173");
      const editor = page.getByRole("textbox", { name: "Scratchpad" });
      const content = Array.from({ length: 80 }, (_, index) => `Visible line ${index + 1}`).join(
        "\n",
      );
      await editor.fill(content);
      await expect(editor).toHaveAttribute("data-acknowledged-revision", /\d+/u);
      await context.setOffline(true);
      const banner = page.getByRole("alert");
      await expect(banner).toContainText("Offline");

      for (const height of [800, 320]) {
        await page.setViewportSize({ width: devices[device].viewport.width, height });
        const bannerBounds = await banner.boundingBox();
        const editorBounds = await editor.boundingBox();
        expect(editorBounds!.y).toBeGreaterThanOrEqual(bannerBounds!.y + bannerBounds!.height);
        expect(editorBounds!.y + editorBounds!.height).toBeLessThanOrEqual(height + 1);
        await editor.evaluate((element: HTMLTextAreaElement) => {
          element.scrollTop = element.scrollHeight;
        });
        await expect(banner).toBeInViewport();
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        await editor.evaluate((element: HTMLTextAreaElement) => {
          element.scrollTop = 0;
          element.setSelectionRange(0, 0);
        });
        await page.screenshot({ path: testInfo.outputPath(`offline-${height}.png`) });
      }

      await context.setOffline(false);
      await expect(banner).toBeHidden();
      expect((await editor.boundingBox())!.y).toBe(0);
      await expect(editor).toHaveValue(content);
    } finally {
      await context.close();
    }
  });
}
