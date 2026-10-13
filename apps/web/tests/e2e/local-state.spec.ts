import { devices, expect, test } from "@playwright/test";

test("renders a durable draft immediately on a warm offline reload", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  await expect(editor).toBeFocused();
  await editor.fill("durable local text");
  await expect(editor).toHaveAttribute("data-persisted", "true");

  await page.evaluate(() => history.replaceState({}, "", "/?transport=offline"));
  const startedAt = Date.now();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(editor).toHaveValue("durable local text");
  expect(Date.now() - startedAt).toBeLessThan(500);
  await expect(page.getByRole("alert")).toContainText("Offline");
});

test("restores cursor, selection, and scroll with About closed", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  const content = Array.from({ length: 120 }, (_, index) => `line ${index}`).join("\n");
  await editor.fill(content);
  await expect(editor).toHaveAttribute("data-persisted", "true");
  await editor.evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(18, 27, "forward");
    element.dispatchEvent(new Event("select"));
    element.scrollTop = 240;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(50);
  await page.evaluate(() => history.replaceState({}, "", "/?transport=offline"));
  await page.reload();

  await expect
    .poll(() =>
      editor.evaluate((element: HTMLTextAreaElement) => ({
        end: element.selectionEnd,
        scrollTop: element.scrollTop,
        start: element.selectionStart,
      })),
    )
    .toMatchObject({ end: 27, start: 18 });
  expect(
    await editor.evaluate((element: HTMLTextAreaElement) => element.scrollTop),
  ).toBeGreaterThan(0);
  await expect(page.getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "About Jotter" })).toBeVisible();
  await expect(page.getByRole("region", { name: "About Jotter" })).toBeHidden();
  await expect(page.locator("nav, menu, [role=status]:visible, [placeholder]")).toHaveCount(0);
});

test("a first-ever offline launch is an error and never an empty editor", async ({ page }) => {
  await page.goto("/?transport=offline");
  await expect(page.getByRole("alert")).toContainText("has not been loaded");
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

for (const device of ["Pixel 7", "iPhone 13"]) {
  test(`${device} autofocuses on launch and offline reload`, async ({ browser, baseURL }) => {
    const context = await browser.newContext(devices[device]);
    try {
      const page = await context.newPage();
      await page.goto(baseURL ?? "http://127.0.0.1:4173");
      const editor = page.getByRole("textbox", { name: "Scratchpad" });
      await expect(editor).toBeFocused();
      await editor.fill("mobile draft");
      await expect(editor).toHaveAttribute("data-persisted", "true");
      await page.evaluate(() => history.replaceState({}, "", "/?transport=offline"));
      await page.reload();
      await expect(editor).toHaveValue("mobile draft");
      await expect(editor).toBeFocused();
    } finally {
      await context.close();
    }
  });
}

test("debounces normal saves and flushes when focus leaves", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  await editor.fill(`debounce baseline ${crypto.randomUUID()}`);
  await editor.blur();
  await expect(editor).toHaveAttribute("data-acknowledged-revision", /\d+/u);
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  const baselineRevision = await editor.getAttribute("data-acknowledged-revision");
  await editor.fill("debounced");
  await page.clock.runFor(299);
  expect(await editor.getAttribute("data-acknowledged-revision")).toBe(baselineRevision);
  await page.clock.runFor(1);
  await expect
    .poll(() => editor.getAttribute("data-acknowledged-revision"))
    .not.toBe(baselineRevision);
  const debouncedRevision = await editor.getAttribute("data-acknowledged-revision");

  await editor.fill("flushed");
  await editor.blur();
  await expect
    .poll(() => editor.getAttribute("data-acknowledged-revision"))
    .not.toBe(debouncedRevision);
});

test("two offline tabs keep distinct durable drafts", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Scratchpad" })).toBeVisible();
  await page.evaluate(() => history.replaceState({}, "", "/?transport=offline"));
  await page.reload();
  const first = page.getByRole("textbox", { name: "Scratchpad" });
  await first.fill("first tab");
  await expect(first).toHaveAttribute("data-persisted", "true");

  const secondPage = await context.newPage();
  await secondPage.goto("/?transport=offline");
  const second = secondPage.getByRole("textbox", { name: "Scratchpad" });
  await second.fill("second tab");
  await expect(second).toHaveAttribute("data-persisted", "true");

  const drafts = await secondPage.evaluate(async () => {
    const request = indexedDB.open("jotter", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.addEventListener("error", () => reject(request.error), { once: true });
      request.addEventListener("success", () => resolve(request.result), { once: true });
    });
    const transaction = database.transaction("drafts", "readonly");
    const getAll = transaction.objectStore("drafts").getAll();
    return await new Promise<Array<{ content: string; sessionId: string }>>((resolve, reject) => {
      getAll.addEventListener("error", () => reject(getAll.error), { once: true });
      getAll.addEventListener("success", () => resolve(getAll.result), { once: true });
    });
  });
  expect(
    drafts.filter((draft) => draft.content === "first tab" || draft.content === "second tab"),
  ).toHaveLength(2);
  expect(new Set(drafts.map((draft) => draft.sessionId)).size).toBeGreaterThanOrEqual(2);
});

test("rejects content beyond one MiB and shows only an actionable error", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  await editor.fill("kept");
  await editor.evaluate((element: HTMLTextAreaElement) => {
    element.value = `${"a".repeat(1_048_576)}x`;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(editor).toHaveValue("kept");
  await expect(page.getByRole("alert")).toContainText("1,048,576");
  await expect(page.getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "About Jotter" })).toBeVisible();
  await expect(page.getByRole("region", { name: "About Jotter" })).toBeHidden();
  await expect(page.locator("[role=status]:visible, nav, menu")).toHaveCount(0);
});
