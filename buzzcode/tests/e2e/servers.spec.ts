import { expect, test } from "@playwright/test";
import { E2eHarness } from "./harness";
import { closeServerSettings, openServerSettings } from "./ui";

const harness = new E2eHarness();

test.beforeAll(async () => {
  await harness.start();
});

test.afterAll(async () => {
  await harness.stop();
});

test("creates the first Server and makes its creator the Owner", async ({
  browser,
  page,
  request,
}) => {
  await page.goto(harness.applicationUrl);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.getByRole("button", { name: "Continue with passkey" }).click();

  await expect(
    page.getByRole("heading", { name: "Create your first Server" }),
  ).toBeVisible();
  await page.getByLabel("Server name").fill("Alpha Server");
  await page.getByRole("button", { name: "Create Server" }).click();

  await expect(page.getByTestId("active-server-name")).toHaveText(
    "Alpha Server",
  );
  await expect(page.getByTestId("active-member-role")).toHaveText("Owner");
  await expect(page.getByTestId("account-handle")).toHaveText("@owner");
  await expect(page.getByTestId("server-rail")).toBeVisible();
  await expect(page.getByTestId("context-sidebar")).toBeVisible();
  await expect(page.getByTestId("content-pane")).toBeVisible();
  await expect(page.getByTestId("member-sidebar")).toBeVisible();
  await expect(
    page
      .getByTestId("member-sidebar")
      .getByRole("heading", { name: "Members" }),
  ).toBeVisible();
  await expect(page.getByTestId("member-sidebar")).toContainText("@owner");
  await expect(page.getByTestId("member-sidebar")).not.toContainText(
    "owner@example.com",
  );
  await page.getByRole("button", { name: "Toggle Members" }).click();
  await expect(page.getByTestId("member-sidebar")).toBeHidden();
  await page.getByRole("button", { name: "Toggle Members" }).click();
  await expect(page.getByTestId("member-sidebar")).toBeVisible();
  await expect(page.getByLabel("New Server name")).toHaveCount(0);

  await openServerSettings(page);
  await expect(page.getByLabel("New Server name")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Server Settings" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Server Settings" }),
  ).toBeFocused();

  await page.getByRole("button", { name: "Home" }).click();
  await expect(
    page.getByRole("heading", { name: "Direct Messages" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Server Channels" }),
  ).toBeHidden();

  await page.getByRole("button", { name: "Alpha Server" }).click();
  await expect(
    page.getByRole("region", { name: "Server Channels" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Direct Messages" }),
  ).toBeHidden();

  await page.setViewportSize({ width: 700, height: 720 });
  await expect(page.getByTestId("context-sidebar")).toBeHidden();
  await page.getByRole("button", { name: "Toggle Channels" }).click();
  await expect(page.getByTestId("context-sidebar")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });

  await openServerSettings(page);
  await page.getByLabel("New Server name").fill("Beta Server");
  await page.getByRole("button", { name: "Create another Server" }).click();
  await expect(page.getByTestId("active-server-name")).toHaveText(
    "Beta Server",
  );

  await page.getByLabel("Durable value").fill("beta-only-value");
  await page.getByRole("button", { name: "Save" }).click();
  await closeServerSettings(page);
  await page.getByRole("button", { name: "Alpha Server" }).click();
  await openServerSettings(page);
  await expect(page.getByTestId("durable-value")).toHaveText(
    "Buzzcode is ready",
  );
  await page.getByLabel("Durable value").fill("alpha-only-value");
  await page.getByRole("button", { name: "Save" }).click();
  await closeServerSettings(page);

  await page.getByRole("button", { name: "Beta Server" }).click();
  await openServerSettings(page);
  await expect(page.getByTestId("durable-value")).toHaveText("beta-only-value");

  const alphaId = await page
    .getByRole("button", { name: "Alpha Server" })
    .getAttribute("data-server-id");
  const betaId = await page
    .getByRole("button", { name: "Beta Server" })
    .getAttribute("data-server-id");
  expect(alphaId).toBeTruthy();
  expect(betaId).toBeTruthy();
  expect(alphaId).not.toBe(betaId);

  const alphaObserver = await page.context().newPage();
  await alphaObserver.goto(harness.applicationUrl);
  await expect(alphaObserver.getByTestId("active-server-name")).toHaveText(
    "Alpha Server",
  );
  await openServerSettings(alphaObserver);
  await expect(alphaObserver.getByTestId("realtime-status")).toHaveText(
    "Connected",
  );

  await page.getByLabel("Durable value").fill("beta-live-update");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(alphaObserver.getByTestId("durable-value")).toHaveText(
    "alpha-only-value",
  );

  await closeServerSettings(page);
  await page.getByRole("button", { name: "Alpha Server" }).click();
  await openServerSettings(page);
  await expect(page.getByTestId("active-server-name")).toHaveText(
    "Alpha Server",
  );
  await expect(page.getByTestId("durable-value")).toHaveText(
    "alpha-only-value",
  );
  await page.getByLabel("Durable value").fill("alpha-live-update");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(alphaObserver.getByTestId("durable-value")).toHaveText(
    "alpha-live-update",
  );

  await request.get(
    `${harness.identityProviderOrigin}/test/next-token?user=outsider`,
  );
  const outsiderContext = await browser.newContext();
  const outsider = await outsiderContext.newPage();
  await outsider.goto(harness.applicationUrl);
  await outsider
    .getByRole("button", { name: "Sign in with a passkey" })
    .click();
  await outsider.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(
    outsider.getByRole("heading", { name: "Create your first Server" }),
  ).toBeVisible();

  const protectedStateUrl = `${harness.apiOrigin}/api/servers/${alphaId}/bootstrap`;
  const httpStatus = await outsider.evaluate(async (url) => {
    return (await fetch(url, { credentials: "include" })).status;
  }, protectedStateUrl);
  expect(httpStatus).toBe(401);

  const protectedEventsUrl = `${harness.apiOrigin.replace(/^http/, "ws")}/api/servers/${alphaId}/events`;
  const websocketResult = await outsider.evaluate(async (url) => {
    return new Promise<"opened" | "rejected">((resolve) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve("opened"), { once: true });
      socket.addEventListener("error", () => resolve("rejected"), {
        once: true,
      });
    });
  }, protectedEventsUrl);
  expect(websocketResult).toBe("rejected");
});
