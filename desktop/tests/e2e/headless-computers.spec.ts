import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const FEATURE_OVERRIDES_KEY = "buzz-feature-overrides-v1";
const VPS_ID = "10000000-0000-4000-8000-000000000002";

async function emitTauriEvent(page: Page, event: string, payload?: unknown) {
  await page.evaluate(
    async ({ eventName, eventPayload }) => {
      const internals = (
        window as Window & {
          __TAURI_INTERNALS__?: {
            invoke?: (
              command: string,
              args: Record<string, unknown>,
            ) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      if (!internals?.invoke) throw new Error("Tauri event bridge unavailable");
      await internals.invoke("plugin:event|emit", {
        event: eventName,
        payload: eventPayload,
      });
    },
    { eventName: event, eventPayload: payload },
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((storageKey) => {
    window.localStorage.setItem(storageKey, JSON.stringify({ projects: true }));
  }, FEATURE_OVERRIDES_KEY);
  await installMockBridge(page, {
    pairedComputers: [
      {
        computerId: VPS_ID,
        computerName: "buzz-vps-01",
        agentPubkey: "ab".repeat(32),
        platform: "linux",
        capabilities: ["files", "shell", "git", "browser"],
        defaultPath: "/srv/projects",
        online: true,
      },
    ],
  });
});

test("headless computer pairs without a VPS GUI", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("profile-popover-settings").click();
  await page.getByTestId("settings-nav-computers").click();

  const settings = page.getByTestId("settings-computers");
  await expect(settings.getByText("buzz-vps-01")).toBeVisible();
  await expect(settings.getByText("Online")).toBeVisible();
  await settings.getByTestId("add-computer-button").click();

  const dialog = page.getByTestId("add-computer-dialog");
  await expect(
    dialog.getByText("buzz-host pair --relay", { exact: false }),
  ).toBeVisible();
  await dialog
    .getByTestId("host-pairing-code")
    .fill("nostrpair://headless-host");
  await dialog.getByTestId("connect-host-pairing").click();
  await emitTauriEvent(page, "host-pairing-sas-received", { sas: "123456" });
  await expect(dialog.getByTestId("host-pairing-sas")).toContainText("123 456");
  await dialog.getByTestId("confirm-host-sas").click();
  await emitTauriEvent(page, "host-pairing-complete", {
    computer: {
      computerId: VPS_ID,
      computerName: "buzz-vps-01",
      agentPubkey: "ab".repeat(32),
      platform: "linux",
      capabilities: ["files", "shell", "git", "browser"],
      defaultPath: "/srv/projects",
      online: false,
    },
  });
  await expect(dialog.getByText("Computer paired")).toBeVisible();
});

test("project creation browses and selects a paired VPS folder", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("open-projects-view").click();
  await page.getByTestId("projects-create-menu").click();
  await page.getByRole("menuitem", { name: "Project", exact: true }).click();

  const createDialog = page.getByTestId("create-project-dialog");
  await createDialog.getByTestId(`project-computer-${VPS_ID}`).click();
  await createDialog.getByTestId("create-project-folder").click();

  const browser = page.getByTestId("remote-folder-browser");
  await expect(browser).toBeVisible();
  await browser.getByTestId("remote-folder-buzz-discord").click();
  await expect(browser.getByText("/srv/projects/buzz-discord")).toBeVisible();
  await browser.getByTestId("select-remote-folder").click();

  await expect(
    createDialog.getByText("/srv/projects/buzz-discord"),
  ).toBeVisible();
  await expect(createDialog.getByTestId("create-project-name")).toHaveValue(
    "buzz-discord",
  );
  await waitForAnimations(page);
});
