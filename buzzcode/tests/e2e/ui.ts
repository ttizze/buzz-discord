import { expect, type Page } from "@playwright/test";

export async function openServerSettings(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Server Settings" });
  if (!(await dialog.isVisible())) {
    await page.getByRole("button", { name: "Server Settings" }).click();
  }
  await expect(dialog).toBeVisible();
}

export async function closeServerSettings(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Server Settings" });
  if (await dialog.isVisible()) {
    await page.getByRole("button", { name: "Close Server Settings" }).click();
  }
  await expect(dialog).toHaveCount(0);
}
