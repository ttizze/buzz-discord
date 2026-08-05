import { expect, type Page, test } from "@playwright/test";
import { E2eHarness } from "./harness";

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

test("chats in an Open Channel with durable flat Replies", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await signIn(owner, "owner");
  await owner.getByLabel("Server name").fill("Chat Server");
  await owner.getByRole("button", { name: "Create Server" }).click();
  await owner.getByLabel("Channel name").fill("general");
  await owner.getByRole("button", { name: "Create Channel" }).click();
  await expect(owner.getByTestId("active-channel-name")).toHaveText(
    "# general",
  );
  const serverId = await owner
    .getByRole("button", { name: "Chat Server" })
    .getAttribute("data-server-id");
  expect(serverId).toBeTruthy();

  await owner.getByLabel("Invite email").fill("member@example.com");
  await owner.getByRole("button", { name: "Create invitation" }).click();
  const invitation = await owner.getByTestId("invitation-code").textContent();

  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  await signIn(member, "member");
  await member.getByLabel("Invitation code").fill(invitation ?? "");
  await member.getByRole("button", { name: "Join Server" }).click();
  await expect(member.getByRole("button", { name: "general" })).toBeVisible();
  await expect(member.getByLabel("Channel name")).toHaveCount(0);

  const forbiddenCreateStatus = await member.evaluate(
    async ({ apiOrigin, serverId }) =>
      (
        await fetch(`${apiOrigin}/api/servers/${serverId}/channels`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "forbidden" }),
        })
      ).status,
    { apiOrigin: harness.apiOrigin, serverId },
  );
  expect(forbiddenCreateStatus).toBe(403);

  await owner.getByLabel("Message #general").fill("First message");
  await owner.getByRole("button", { name: "Send" }).click();
  await expect(
    member.getByText("First message", { exact: true }),
  ).toBeVisible();
  await expect(
    owner.locator("[data-message-id]", { hasText: "First message" }),
  ).toHaveCount(1);

  await member
    .locator("[data-message-id]", { hasText: "First message" })
    .getByRole("button", { name: "Reply to owner" })
    .click();
  await member.getByLabel("Message #general").fill("Reply one");
  await member.getByRole("button", { name: "Send" }).click();
  const firstReply = owner.locator("[data-message-id]", {
    hasText: "Reply one",
  });
  await expect(firstReply).toContainText("First message");

  await firstReply.getByRole("button", { name: "Reply to member" }).click();
  await owner.getByLabel("Message #general").fill("Reply two");
  await owner.getByRole("button", { name: "Send" }).click();
  const secondReply = member.locator("[data-message-id]", {
    hasText: "Reply two",
  });
  await expect(secondReply).toContainText("Reply one");
  await expect(secondReply.locator(".reply-reference")).toHaveCount(1);
  await expect(secondReply).not.toContainText("First message");

  const channelId = await owner
    .getByRole("button", { name: "general" })
    .getAttribute("data-channel-id");
  expect(channelId).toBeTruthy();
  await owner.evaluate(
    async ({ apiOrigin, serverId, channelId }) => {
      for (let index = 0; index < 52; index += 1) {
        const response = await fetch(
          `${apiOrigin}/api/servers/${serverId}/channels/${channelId}/messages`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: `Paginated ${index}` }),
          },
        );
        if (!response.ok) throw new Error(`message ${index} failed`);
      }
    },
    { apiOrigin: harness.apiOrigin, serverId, channelId },
  );

  await member.reload();
  await expect(
    member.getByRole("button", { name: "Load older messages" }),
  ).toBeVisible();
  await expect(member.getByText("Paginated 51", { exact: true })).toBeVisible();
  await expect(member.getByText("First message", { exact: true })).toHaveCount(
    0,
  );
  await member.getByRole("button", { name: "Load older messages" }).click();
  await expect(
    member.locator(".message > p").filter({ hasText: /^First message$/ }),
  ).toBeVisible();

  await harness.restartServer();
  await expect(member.getByTestId("realtime-status")).toHaveText("Connected", {
    timeout: 10_000,
  });
  await expect(
    member.locator("[data-message-id]", { hasText: "Reply two" }),
  ).toHaveCount(1);
  await expect(
    member.locator("[data-message-id]", { hasText: "Paginated 51" }),
  ).toHaveCount(1);

  await memberContext.close();
  await ownerContext.close();
});
