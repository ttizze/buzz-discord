import { expect, type Page, test } from "@playwright/test";
import { E2eHarness } from "./harness";
import { openServerSettings } from "./ui";

const harness = new E2eHarness();

test.beforeAll(async () => {
  await harness.start();
});

test.afterAll(async () => {
  await harness.stop();
});

async function signIn(page: Page): Promise<void> {
  await page.goto(harness.applicationUrl);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(page.getByTestId("signed-in-user")).toHaveText(
    "owner@example.com",
  );
  await page.getByLabel("Server name").fill("Persistence Server");
  await page.getByRole("button", { name: "Create Server" }).click();
}

test("persists a value, broadcasts it, and reads it after restart", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const observer = await context.newPage();
  const writer = await context.newPage();

  await signIn(observer);
  await writer.goto(harness.applicationUrl);
  await expect(observer.getByTestId("realtime-status")).toHaveText("Connected");
  await expect(writer.getByTestId("realtime-status")).toHaveText("Connected");

  const durableValue = "persisted-after-restart";
  await openServerSettings(observer);
  await openServerSettings(writer);
  await writer.getByLabel("Durable value").fill(durableValue);
  await writer.getByRole("button", { name: "Save" }).click();

  await expect(observer.getByTestId("durable-value")).toHaveText(durableValue);

  await harness.restartServer();

  await observer.reload();
  await openServerSettings(observer);
  await expect(observer.getByTestId("durable-value")).toHaveText(durableValue);
});
