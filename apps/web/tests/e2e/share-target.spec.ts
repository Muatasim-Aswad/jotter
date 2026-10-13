import { expect, test, type BrowserContext, type Page } from "@playwright/test";

interface ShareValues {
  text?: string;
  title?: string;
  url?: string;
}

async function installAndControl(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Scratchpad" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
}

async function postShare(page: Page, values: ShareValues): Promise<void> {
  const result = await page.evaluate(async (payload) => {
    const response = await fetch("/share", {
      body: new URLSearchParams(Object.entries(payload)),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });
    return { status: response.status, type: response.type };
  }, values);
  expect(result).toMatchObject({ status: 0, type: "opaqueredirect" });
}

async function inbox(page: Page): Promise<Array<{ id: string; state: string }>> {
  return page.evaluate(async () => {
    const request = indexedDB.open("jotter", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.addEventListener("error", () => reject(request.error), { once: true });
      request.addEventListener("success", () => resolve(request.result), { once: true });
    });
    const getAll = database.transaction("share-inbox").objectStore("share-inbox").getAll();
    const result = await new Promise<Array<{ id: string; state: string }>>((resolve, reject) => {
      getAll.addEventListener("error", () => reject(getAll.error), { once: true });
      getAll.addEventListener("success", () => resolve(getAll.result), { once: true });
    });
    database.close();
    return result;
  });
}

async function clearLocalDocument(page: Page): Promise<void> {
  await page.evaluate(async () => {
    sessionStorage.clear();
    const request = indexedDB.open("jotter", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.addEventListener("error", () => reject(request.error), { once: true });
      request.addEventListener("success", () => resolve(request.result), { once: true });
    });
    const transaction = database.transaction(["drafts", "server-cache"], "readwrite");
    transaction.objectStore("drafts").clear();
    transaction.objectStore("server-cache").clear();
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
    });
    database.close();
  });
}

async function reopen(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/");
  return page;
}

test("commits the POST before redirect and appends once in title-text-URL order", async ({
  page,
}) => {
  await installAndControl(page);
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  const base = `base ${crypto.randomUUID()}`;
  await editor.fill(base);
  await expect(editor).toHaveAttribute("data-persisted", "true");
  await postShare(page, {
    text: "Shared title",
    title: "Shared title",
    url: "https://example.test/item",
  });
  expect(await inbox(page)).toHaveLength(1);

  await page.reload();
  const expected = `${base}\n\nShared title\nhttps://example.test/item`;
  await expect(editor).toHaveValue(expected);
  await expect(editor).toBeFocused();
  expect(await editor.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(
    expected.length,
  );
  await expect(editor).toHaveAttribute("data-acknowledged-revision", /\d+/u);
  expect(await inbox(page)).toEqual([expect.objectContaining({ state: "consumed" })]);

  await page.reload();
  await expect(editor).toHaveValue(expected);
});

test("an offline share uses the normal outbox when connectivity returns", async ({
  context,
  page,
}) => {
  await installAndControl(page);
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  const base = `offline base ${crypto.randomUUID()}`;
  await editor.fill(base);
  await expect(editor).toHaveAttribute("data-persisted", "true");
  await editor.blur();
  await expect(editor).toHaveAttribute("data-acknowledged-revision", /\d+/u);

  await context.setOffline(true);
  await postShare(page, { text: "offline payload" });
  await page.reload();
  await expect(editor).toHaveValue(`${base}\n\noffline payload`);
  await expect(page.getByRole("alert")).toContainText("Offline");

  await context.setOffline(false);
  await expect(editor).toHaveAttribute("data-acknowledged-revision", /\d+/u, { timeout: 10_000 });
  expect(await inbox(page)).toEqual([expect.objectContaining({ state: "consumed" })]);
});

test("a share survives foreground startup failure and is consumed after recovery", async ({
  context,
  page,
}) => {
  await installAndControl(page);
  await clearLocalDocument(page);
  await context.setOffline(true);
  await postShare(page, { title: "survives startup" });
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("has not been loaded");
  expect(await inbox(page)).toEqual([expect.objectContaining({ state: "pending" })]);

  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Scratchpad" })).toHaveValue(/survives startup$/u);
  expect(await inbox(page)).toEqual([expect.objectContaining({ state: "consumed" })]);
});

test("an over-limit append stays pending without truncating the draft", async ({ page }) => {
  await installAndControl(page);
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  const content = "a".repeat(1_048_575);
  await editor.fill(content);
  await expect(editor).toHaveAttribute("data-persisted", "true");
  await postShare(page, { text: "x" });
  await page.reload();

  expect(await editor.evaluate((element: HTMLTextAreaElement) => element.value.length)).toBe(
    content.length,
  );
  await expect(page.getByRole("alert")).toContainText("shared item is waiting");
  expect(await inbox(page)).toEqual([expect.objectContaining({ state: "pending" })]);
});

test("foreground termination at the consume boundary cannot duplicate a share", async ({
  context,
  page,
}) => {
  await installAndControl(page);
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  const base = `crash boundary ${crypto.randomUUID()}`;
  await editor.fill(base);
  await expect(editor).toHaveAttribute("data-persisted", "true");
  await postShare(page, { text: "transaction payload" });

  await page.reload({ waitUntil: "commit" });
  await page.close();
  const recovered = await reopen(context);
  const value = await recovered.getByRole("textbox", { name: "Scratchpad" }).inputValue();
  expect(value).toBe(`${base}\n\ntransaction payload`);
  expect(value.match(/transaction payload/gu)).toHaveLength(1);
});
