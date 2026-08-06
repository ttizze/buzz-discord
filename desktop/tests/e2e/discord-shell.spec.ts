import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
});

async function openGeneralChannel(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
}

test("presents the Discord-style server, voice, chat, and member layout", async ({
  page,
}) => {
  await openGeneralChannel(page);

  await expect(page.getByTestId("community-rail")).toBeVisible();
  await expect(page.getByTestId("discord-community-header")).toContainText(
    "Server",
  );
  await expect(page.getByTestId("discord-voice-section")).toContainText(
    "general",
  );
  await expect(page.getByTestId("discord-members-rail")).toBeVisible();
  await expect(page.getByTestId("discord-members-rail")).toContainText(
    "Agents",
  );
  await expect(page.getByTestId("discord-members-rail")).toContainText(
    "Admins",
  );
});

test("opens role management from the persistent member rail", async ({
  page,
}) => {
  await openGeneralChannel(page);

  await page
    .getByTestId("discord-members-rail")
    .getByRole("button", { name: /Members/ })
    .click();

  await expect(page.getByTestId("members-sidebar")).toBeVisible();
});

test("keeps compact layouts usable without the persistent member rail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  await openGeneralChannel(page);

  await expect(page.getByTestId("discord-members-rail")).toBeHidden();
  await expect(page.getByTestId("channel-members-trigger")).toBeVisible();
});
