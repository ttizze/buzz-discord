import { expect, test } from "@playwright/test";
import { E2eHarness } from "./harness";

const harness = new E2eHarness();

test.beforeAll(async () => {
  await harness.start();
});

test.afterAll(async () => {
  await harness.stop();
});

test("persists a value, broadcasts it, and reads it after restart", async ({
  browser,
}) => {
  const observer = await browser.newPage();
  const writer = await browser.newPage();

  await observer.goto(harness.applicationUrl);
  await writer.goto(harness.applicationUrl);
  await expect(observer.getByTestId("realtime-status")).toHaveText("Connected");
  await expect(writer.getByTestId("realtime-status")).toHaveText("Connected");

  const durableValue = "persisted-after-restart";
  await writer.getByLabel("Durable value").fill(durableValue);
  await writer.getByRole("button", { name: "Save" }).click();

  await expect(observer.getByTestId("durable-value")).toHaveText(durableValue);

  await harness.restartServer();

  await observer.reload();
  await expect(observer.getByTestId("durable-value")).toHaveText(durableValue);
});
