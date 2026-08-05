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

async function signIn(page: Page, user: string): Promise<void> {
  await fetch(`${harness.identityProviderOrigin}/test/next-token?user=${user}`);
  await page.goto(harness.applicationUrl);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.getByRole("button", { name: "Continue with passkey" }).click();
}

test("invites members and enforces fixed Server roles", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await signIn(owner, "owner");
  await owner.getByLabel("Server name").fill("Team Server");
  await owner.getByRole("button", { name: "Create Server" }).click();
  await expect(owner.getByTestId("active-member-role")).toHaveText("Owner");
  await expect(owner.getByTestId("realtime-status")).toHaveText("Connected");
  const serverId = await owner
    .getByRole("button", { name: "Team Server" })
    .getAttribute("data-server-id");
  expect(serverId).toBeTruthy();

  await openServerSettings(owner);
  await owner.getByLabel("Invite email").fill("admin@example.com");
  await owner.getByRole("button", { name: "Create invitation" }).click();
  const adminInvitation = await owner
    .getByTestId("invitation-code")
    .textContent();
  expect(adminInvitation).toBeTruthy();

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signIn(admin, "admin");
  await admin.getByLabel("Invitation code").fill(adminInvitation ?? "");
  await admin.getByRole("button", { name: "Join Server" }).click();
  await expect(admin.getByTestId("active-server-name")).toHaveText(
    "Team Server",
  );
  await expect(admin.getByTestId("active-member-role")).toHaveText("Member");
  await expect(admin.getByTestId("realtime-status")).toHaveText("Connected");
  await expect(
    owner.getByTestId("member-sidebar").getByText("admin (@admin)"),
  ).toBeVisible();

  await owner.getByLabel("Role for @admin").selectOption("admin");
  await expect(admin.getByTestId("active-member-role")).toHaveText("Admin");
  await openServerSettings(admin);
  await expect(admin.getByLabel("Invite email")).toBeVisible();

  await admin.getByLabel("Invite email").fill("member@example.com");
  await admin.getByRole("button", { name: "Create invitation" }).click();
  const memberInvitation = await admin
    .getByTestId("invitation-code")
    .textContent();
  expect(memberInvitation).toBeTruthy();

  const wrongUserStatus = await admin.evaluate(
    async ({ apiOrigin, token }) =>
      (
        await fetch(`${apiOrigin}/api/invitations/accept`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        })
      ).status,
    { apiOrigin: harness.apiOrigin, token: memberInvitation },
  );
  expect(wrongUserStatus).toBe(403);

  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  await signIn(member, "member");
  await member.getByLabel("Invitation code").fill(memberInvitation ?? "");
  await member.getByRole("button", { name: "Join Server" }).click();
  await expect(member.getByTestId("active-member-role")).toHaveText("Member");
  await expect(member.getByTestId("realtime-status")).toHaveText("Connected");
  await expect(member.getByLabel("Invite email")).toHaveCount(0);

  const replayStatus = await member.evaluate(
    async ({ apiOrigin, token }) =>
      (
        await fetch(`${apiOrigin}/api/invitations/accept`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        })
      ).status,
    { apiOrigin: harness.apiOrigin, token: memberInvitation },
  );
  expect(replayStatus).toBe(404);

  const memberInviteStatus = await member.evaluate(
    async ({ apiOrigin, serverId }) =>
      (
        await fetch(`${apiOrigin}/api/servers/${serverId}/invitations`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "forbidden@example.com" }),
        })
      ).status,
    { apiOrigin: harness.apiOrigin, serverId },
  );
  expect(memberInviteStatus).toBe(403);

  await admin.getByLabel("Role for @member").selectOption("admin");
  await expect(member.getByTestId("active-member-role")).toHaveText("Admin");
  await admin.getByLabel("Role for @member").selectOption("member");
  await expect(member.getByTestId("active-member-role")).toHaveText("Member");

  const adminTransferStatus = await admin.evaluate(
    async ({ apiOrigin, serverId, newOwnerSubject }) =>
      (
        await fetch(`${apiOrigin}/api/servers/${serverId}/owner`, {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ newOwnerSubject }),
        })
      ).status,
    {
      apiOrigin: harness.apiOrigin,
      serverId,
      newOwnerSubject: "rauthy-member",
    },
  );
  expect(adminTransferStatus).toBe(403);

  const adminDeleteStatus = await admin.evaluate(
    async ({ apiOrigin, serverId }) =>
      (
        await fetch(`${apiOrigin}/api/servers/${serverId}`, {
          method: "DELETE",
          credentials: "include",
        })
      ).status,
    { apiOrigin: harness.apiOrigin, serverId },
  );
  expect(adminDeleteStatus).toBe(403);

  await expect(owner.getByTestId("audit-history")).toContainText(
    "member.role_changed",
  );
  await owner
    .locator("li", { hasText: "@admin" })
    .getByRole("button", { name: "Transfer ownership" })
    .click();
  await expect(owner.getByTestId("active-member-role")).toHaveText("Admin");
  await expect(admin.getByTestId("active-member-role")).toHaveText("Owner");
  await expect(
    admin.locator("[aria-labelledby='members-heading'] strong", {
      hasText: "Owner",
    }),
  ).toHaveCount(1);
  await expect(
    admin.getByTestId("member-sidebar").getByText("owner (@owner)"),
  ).toBeVisible();
  await expect(admin.getByTestId("audit-history")).toContainText(
    "ownership.transferred",
  );

  const previousOwnerDeleteStatus = await owner.evaluate(
    async ({ apiOrigin, serverId }) =>
      (
        await fetch(`${apiOrigin}/api/servers/${serverId}`, {
          method: "DELETE",
          credentials: "include",
        })
      ).status,
    { apiOrigin: harness.apiOrigin, serverId },
  );
  expect(previousOwnerDeleteStatus).toBe(403);

  await admin.getByRole("button", { name: "Delete Server" }).click();
  await expect(
    admin.getByRole("heading", { name: "Create your first Server" }),
  ).toBeVisible();
  await expect(
    owner.getByRole("heading", { name: "Create your first Server" }),
  ).toBeVisible();
  await expect(
    member.getByRole("heading", { name: "Create your first Server" }),
  ).toBeVisible();

  await memberContext.close();
  await adminContext.close();
  await ownerContext.close();
});
