import { expect, test } from "@playwright/test";

test("runtime assets stay on the application origin", async ({ page }) => {
  const unexpected: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:4173") unexpected.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Scratchpad" })).toBeVisible();
  await page.evaluate(async () => navigator.serviceWorker.ready);
  expect(unexpected).toEqual([]);
});

test("maximum-size input remains responsive without synchronizing the probe", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseURL ?? "http://127.0.0.1:4173");
  await expect(page.getByRole("textbox", { name: "Scratchpad" })).toBeVisible();
  await page.evaluate(() => history.replaceState({}, "", "/?transport=offline"));
  await page.reload();
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  const inputDuration = await editor.evaluate((element: HTMLTextAreaElement) => {
    const startedAt = performance.now();
    element.value = "x".repeat(1_048_576);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    return performance.now() - startedAt;
  });
  expect(inputDuration).toBeLessThan(100);
  await expect(editor).toHaveAttribute("data-persisted", "true");
  await context.close();
});

test("debounced save and clean-client propagation meet release targets", async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();
  await firstPage.goto("/");
  await secondPage.goto("/");
  const first = firstPage.getByRole("textbox", { name: "Scratchpad" });
  const second = secondPage.getByRole("textbox", { name: "Scratchpad" });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();

  const baseline = `performance baseline ${crypto.randomUUID()}`;
  await first.fill(baseline);
  await first.blur();
  await expect(first).toHaveAttribute("data-acknowledged-revision", /\d+/u);
  await expect(second).toHaveValue(baseline);
  const previousRevision = await first.getAttribute("data-acknowledged-revision");
  const content = `performance ${crypto.randomUUID()}`;
  const startedAt = Date.now();
  await first.fill(content);
  await expect
    .poll(() => first.getAttribute("data-acknowledged-revision"), { timeout: 1_000 })
    .not.toBe(previousRevision);
  await expect(second).toHaveValue(content, { timeout: 1_000 });
  expect(Date.now() - startedAt).toBeLessThan(1_000);

  await firstContext.close();
  await secondContext.close();
});
