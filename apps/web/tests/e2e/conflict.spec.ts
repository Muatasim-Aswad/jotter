import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";

async function openEditor(page: Page): Promise<Locator> {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  await expect(editor).toBeVisible();
  return editor;
}

async function createConflict(
  offlineContext: BrowserContext,
  offlinePage: Page,
  onlineEditor: Locator,
  localContent: string,
  serverContent: string,
): Promise<void> {
  await offlineContext.setOffline(true);
  const offlineEditor = offlinePage.getByRole("textbox", { name: "Scratchpad" });
  await offlineEditor.fill(localContent);
  await expect(offlineEditor).toHaveAttribute("data-persisted", "true");
  await onlineEditor.fill(serverContent);
  await onlineEditor.blur();
  await expect(onlineEditor).toHaveAttribute("data-acknowledged-revision", /\d+/u);
  await offlineContext.setOffline(false);
  await expect(
    offlinePage.getByRole("heading", { name: "Choose which version to keep" }),
  ).toBeVisible();
}

test("stale reconnect persists conflicts and supports every resolution choice", async ({
  browser,
}) => {
  const onlineContext = await browser.newContext();
  const offlineContext = await browser.newContext();
  const onlinePage = await onlineContext.newPage();
  const offlinePage = await offlineContext.newPage();
  const onlineEditor = await openEditor(onlinePage);
  await openEditor(offlinePage);

  const marker = crypto.randomUUID();
  const firstLocal = `local first ${marker}`;
  const firstServer = `server first ${marker}`;
  await createConflict(offlineContext, offlinePage, onlineEditor, firstLocal, firstServer);
  await offlinePage.reload();
  await expect(
    offlinePage.getByRole("heading", { name: "Choose which version to keep" }),
  ).toBeVisible();
  await offlinePage.getByRole("button", { name: "Use server" }).click();
  await expect(offlinePage.getByRole("textbox", { name: "Scratchpad" })).toHaveValue(firstServer);

  const secondLocal = `local second ${marker}`;
  const secondServer = `server second ${marker}`;
  await createConflict(offlineContext, offlinePage, onlineEditor, secondLocal, secondServer);
  await offlinePage.getByRole("button", { name: "Use this device" }).click();
  await expect(offlinePage.getByRole("textbox", { name: "Scratchpad" })).toHaveValue(secondLocal);
  await expect(onlineEditor).toHaveValue(secondLocal);

  const thirdLocal = `local third ${marker}`;
  const thirdServer = `server third ${marker}`;
  const edited = `edited resolution ${marker}`;
  await createConflict(offlineContext, offlinePage, onlineEditor, thirdLocal, thirdServer);
  await offlinePage.getByRole("button", { name: "Edit resolution" }).click();
  await offlinePage.getByRole("textbox", { name: "Edit conflict resolution" }).fill(edited);
  await offlinePage.getByRole("button", { name: "Use edited resolution" }).click();
  await expect(offlinePage.getByRole("textbox", { name: "Scratchpad" })).toHaveValue(edited);
  await expect(onlineEditor).toHaveValue(edited);

  await onlineContext.close();
  await offlineContext.close();
});

test("two tabs edited offline preserve accepted and conflicted versions", async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();
  const firstEditor = await openEditor(firstPage);
  const secondEditor = await openEditor(secondPage);
  const marker = crypto.randomUUID();
  const firstContent = `first offline draft ${marker}`;
  const secondContent = `second offline draft ${marker}`;

  await Promise.all([firstContext.setOffline(true), secondContext.setOffline(true)]);
  await firstEditor.fill(firstContent);
  await secondEditor.fill(secondContent);
  await expect(firstEditor).toHaveAttribute("data-persisted", "true");
  await expect(secondEditor).toHaveAttribute("data-persisted", "true");

  await firstContext.setOffline(false);
  await expect(firstEditor).toHaveAttribute("data-acknowledged-revision", /\d+/u);
  await secondContext.setOffline(false);
  await expect(
    secondPage.getByRole("heading", { name: "Choose which version to keep" }),
  ).toBeVisible();
  await expect(secondPage.locator(".conflict-screen")).toContainText(firstContent);
  await expect(secondPage.locator(".conflict-screen")).toContainText(secondContent);
  await secondPage.getByRole("button", { name: "Use server" }).click();
  await expect(secondPage.getByRole("textbox", { name: "Scratchpad" })).toHaveValue(firstContent);

  await firstContext.close();
  await secondContext.close();
});
