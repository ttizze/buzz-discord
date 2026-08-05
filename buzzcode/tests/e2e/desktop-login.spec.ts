import { expect, test } from "@playwright/test";
import { E2eHarness } from "./harness";

const harness = new E2eHarness();

test.beforeAll(async () => {
  await harness.start();
});

test.afterAll(async () => {
  await harness.stop();
});

test("opens desktop OIDC in the system browser instead of navigating the WebView", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const testWindow = window as Window & {
      __TAURI_INTERNALS__?: Readonly<{
        invoke: (command: string, args: unknown) => Promise<unknown>;
      }>;
      __BUZZCODE_OPENED_URL__?: string;
    };
    testWindow.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        if (command.includes("opener")) {
          const value = args as { url?: string };
          testWindow.__BUZZCODE_OPENED_URL__ = value.url;
        }
        return null;
      },
    };
  });
  await page.goto(harness.applicationUrl);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();

  const openedUrl = await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __BUZZCODE_OPENED_URL__?: string })
            .__BUZZCODE_OPENED_URL__,
      ),
    )
    .toContain("/authorize")
    .then(() =>
      page.evaluate(
        () =>
          (window as Window & { __BUZZCODE_OPENED_URL__?: string })
            .__BUZZCODE_OPENED_URL__,
      ),
    );
  await expect(page).toHaveURL(harness.applicationUrl);
  expect(openedUrl).toBeTruthy();

  const systemBrowser = await page.context().newPage();
  await systemBrowser.goto(openedUrl ?? "");
  await systemBrowser
    .getByRole("button", { name: "Continue with passkey" })
    .click();
  await expect(
    systemBrowser.getByRole("heading", { name: "Buzzcode sign-in complete" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Create your first Server" }),
  ).toBeVisible();
});
