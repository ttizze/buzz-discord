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

  const firstMessage = owner
    .locator(".message > p")
    .filter({ hasText: /^First message$/ })
    .locator("..");
  const firstMessageId = await firstMessage.getAttribute("data-message-id");
  expect(firstMessageId).toBeTruthy();
  const ownerFirstMessage = owner.locator(
    `[data-message-id="${firstMessageId}"]`,
  );
  const memberEditStatus = await member.evaluate(
    async ({ apiOrigin, serverId, channelId, messageId }) =>
      (
        await fetch(
          `${apiOrigin}/api/servers/${serverId}/channels/${channelId}/messages/${messageId}`,
          {
            method: "PATCH",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: "forbidden edit" }),
          },
        )
      ).status,
    {
      apiOrigin: harness.apiOrigin,
      serverId,
      channelId: await owner
        .getByRole("button", { name: "general" })
        .getAttribute("data-channel-id"),
      messageId: firstMessageId,
    },
  );
  expect(memberEditStatus).toBe(403);

  await ownerFirstMessage
    .getByRole("button", { name: "Edit message by owner" })
    .click();
  await ownerFirstMessage
    .getByRole("textbox", { name: "Edit message by owner" })
    .fill("First message edited");
  await ownerFirstMessage.getByRole("button", { name: "Save edit" }).click();
  await expect(
    member.locator(`[data-message-id="${firstMessageId}"]`),
  ).toContainText("First message edited");
  await expect(ownerFirstMessage).toContainText("edited");

  const memberFirstMessage = member.locator(
    `[data-message-id="${firstMessageId}"]`,
  );
  await memberFirstMessage
    .getByRole("button", { name: "React with 👍" })
    .click();
  await expect(
    ownerFirstMessage.getByRole("button", { name: "React with 👍" }),
  ).toContainText("1");
  const duplicateReactionStatus = await member.evaluate(
    async ({ apiOrigin, serverId, channelId, messageId }) =>
      (
        await fetch(
          `${apiOrigin}/api/servers/${serverId}/channels/${channelId}/messages/${messageId}/reactions`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ emoji: "👍" }),
          },
        )
      ).status,
    {
      apiOrigin: harness.apiOrigin,
      serverId,
      channelId: await owner
        .getByRole("button", { name: "general" })
        .getAttribute("data-channel-id"),
      messageId: firstMessageId,
    },
  );
  expect(duplicateReactionStatus).toBe(200);
  await expect(
    ownerFirstMessage.getByRole("button", { name: "React with 👍" }),
  ).toContainText("1");
  await memberFirstMessage
    .getByRole("button", { name: "React with 👍" })
    .click();
  await expect(
    ownerFirstMessage.getByRole("button", { name: "React with 👍" }),
  ).toHaveText("👍");

  const replyOneMessage = member
    .locator(".message > p")
    .filter({ hasText: /^Reply one$/ })
    .locator("..");
  const replyOneId = await replyOneMessage.getAttribute("data-message-id");
  expect(replyOneId).toBeTruthy();
  const memberReplyOne = member.locator(`[data-message-id="${replyOneId}"]`);
  await memberReplyOne
    .getByRole("button", { name: "Edit message by member" })
    .click();
  await memberReplyOne
    .getByRole("textbox", { name: "Edit message by member" })
    .fill("Reply one edited");
  await memberReplyOne.getByRole("button", { name: "Save edit" }).click();
  await expect(secondReply).toContainText("Reply one edited");

  const unauthorizedDeleteStatus = await member.evaluate(
    async ({ apiOrigin, serverId, channelId, messageId }) =>
      (
        await fetch(
          `${apiOrigin}/api/servers/${serverId}/channels/${channelId}/messages/${messageId}`,
          { method: "DELETE", credentials: "include" },
        )
      ).status,
    {
      apiOrigin: harness.apiOrigin,
      serverId,
      channelId: await owner
        .getByRole("button", { name: "general" })
        .getAttribute("data-channel-id"),
      messageId: firstMessageId,
    },
  );
  expect(unauthorizedDeleteStatus).toBe(403);

  const ownerReplyOne = owner.locator(`[data-message-id="${replyOneId}"]`);
  await ownerReplyOne
    .getByRole("button", { name: "Delete message by member" })
    .click();
  await expect(ownerReplyOne).toContainText("Message deleted");
  await expect(
    member.locator(`[data-message-id="${replyOneId}"]`),
  ).toContainText("Message deleted");
  await expect(secondReply.locator(".reply-reference")).toContainText(
    "Message deleted",
  );

  const repeatedDeleteStatus = await owner.evaluate(
    async ({ apiOrigin, serverId, channelId, messageId }) =>
      (
        await fetch(
          `${apiOrigin}/api/servers/${serverId}/channels/${channelId}/messages/${messageId}`,
          { method: "DELETE", credentials: "include" },
        )
      ).status,
    {
      apiOrigin: harness.apiOrigin,
      serverId,
      channelId: await owner
        .getByRole("button", { name: "general" })
        .getAttribute("data-channel-id"),
      messageId: replyOneId,
    },
  );
  expect(repeatedDeleteStatus).toBe(200);
  const deletedReadback = await owner.evaluate(
    async ({ apiOrigin, serverId, channelId, messageId }) => {
      const response = await fetch(
        `${apiOrigin}/api/servers/${serverId}/channels/${channelId}/messages/${messageId}`,
        { credentials: "include" },
      );
      return { status: response.status, body: await response.json() };
    },
    {
      apiOrigin: harness.apiOrigin,
      serverId,
      channelId: await owner
        .getByRole("button", { name: "general" })
        .getAttribute("data-channel-id"),
      messageId: replyOneId,
    },
  );
  expect(deletedReadback.status).toBe(200);
  expect(deletedReadback.body.content).toBeNull();
  const deletedReactionStatus = await member.evaluate(
    async ({ apiOrigin, serverId, channelId, messageId }) =>
      (
        await fetch(
          `${apiOrigin}/api/servers/${serverId}/channels/${channelId}/messages/${messageId}/reactions`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ emoji: "👍" }),
          },
        )
      ).status,
    {
      apiOrigin: harness.apiOrigin,
      serverId,
      channelId: await owner
        .getByRole("button", { name: "general" })
        .getAttribute("data-channel-id"),
      messageId: replyOneId,
    },
  );
  expect(deletedReactionStatus).toBe(404);
  const deletionAuditCount = await owner.evaluate(
    async ({ apiOrigin, serverId, messageId }) => {
      const response = await fetch(
        `${apiOrigin}/api/servers/${serverId}/audit`,
        { credentials: "include" },
      );
      const entries = (await response.json()) as {
        action: string;
        detail: { messageId?: string };
      }[];
      return entries.filter(
        (entry) =>
          entry.action === "message.deleted" &&
          entry.detail.messageId === messageId,
      ).length;
    },
    { apiOrigin: harness.apiOrigin, serverId, messageId: replyOneId },
  );
  expect(deletionAuditCount).toBe(1);
  await expect(owner.getByTestId("audit-history")).toContainText(
    "message.edited",
  );
  await expect(owner.getByTestId("audit-history")).toContainText(
    "message.deleted",
  );
  await expect(owner.getByTestId("audit-history")).toContainText(
    "reaction.removed",
  );

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
  await expect(
    member.getByText("First message edited", { exact: true }),
  ).toHaveCount(0);
  await member.getByRole("button", { name: "Load older messages" }).click();
  await expect(
    member
      .locator(".message > p")
      .filter({ hasText: /^First message edited$/ }),
  ).toBeVisible();

  await harness.restartServer();
  await expect(member.getByTestId("realtime-status")).toHaveText("Connected", {
    timeout: 10_000,
  });
  await expect(
    member.locator("[data-message-id]", { hasText: "Reply two" }),
  ).toHaveCount(1);
  await expect(
    member
      .locator("[data-message-id]", { hasText: "Reply two" })
      .locator(".reply-reference"),
  ).toContainText("Message deleted");
  await expect(
    member.locator("[data-message-id]", { hasText: "Paginated 51" }),
  ).toHaveCount(1);

  await memberContext.close();
  await ownerContext.close();
});
