import { expect, test, type Page } from "@playwright/test";

async function openEditor(page: Page) {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Scratchpad" });
  await expect(editor).toBeVisible();
  return editor;
}

test("a clean client follows committed updates without losing focus or selection", async ({
  browser,
}) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();
  const first = await openEditor(firstPage);
  const second = await openEditor(secondPage);
  const content = `clean propagation ${crypto.randomUUID()}`;

  await second.focus();
  await second.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
  await first.fill(content);
  await first.blur();

  await expect(first).toHaveAttribute("data-acknowledged-revision", /\d+/u);
  await expect(second).toHaveValue(content);
  await expect(second).toBeFocused();
  expect(await second.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(0);

  await secondPage.reload();
  await expect(secondPage.getByRole("textbox", { name: "Scratchpad" })).toHaveValue(content);
  await firstContext.close();
  await secondContext.close();
});

test("a lost acknowledgement retry and duplicate mutation return the original revision", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const bootstrap = (await fetch("/api/v1/bootstrap").then((response) => response.json())) as {
      scratchpad: { id: string; revision: number };
    };
    const mutationId = crypto.randomUUID();
    const clientId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const content = `idempotent ${mutationId}`;
    return new Promise<{ first: number; second: number }>((resolve, reject) => {
      const socket = new WebSocket(new URL("/ws", location.href));
      const acknowledgements: number[] = [];
      const save = {
        baseRevision: bootstrap.scratchpad.revision,
        clientId,
        content,
        mutationId,
        scratchpadId: bootstrap.scratchpad.id,
        sessionId,
        type: "save",
        v: 1,
      };
      socket.addEventListener("open", () =>
        socket.send(
          JSON.stringify({
            clientId,
            knownRevision: bootstrap.scratchpad.revision,
            pendingMutationIds: [mutationId],
            scratchpadId: bootstrap.scratchpad.id,
            sessionId,
            type: "hello",
            v: 1,
          }),
        ),
      );
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          code?: string;
          revision?: number;
          type: string;
        };
        if (message.type === "state") socket.send(JSON.stringify(save));
        if (message.type === "ack" && message.revision !== undefined) {
          acknowledgements.push(message.revision);
          if (acknowledgements.length === 1) socket.send(JSON.stringify(save));
          if (acknowledgements.length === 2) {
            socket.close();
            resolve({ first: acknowledgements[0]!, second: acknowledgements[1]! });
          }
        }
        if (message.type === "error") reject(new Error(message.code));
      });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed")));
    });
  });

  expect(result.second).toBe(result.first);
});
