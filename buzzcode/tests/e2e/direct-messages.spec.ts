import { expect, type Page, test } from "@playwright/test";
import { E2eHarness } from "./harness";
import { closeServerSettings, openServerSettings } from "./ui";

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
  await expect(page.getByText(`${user}@example.com`)).toBeVisible();
}

test("exchanges a durable one-to-one Direct Message outside Servers", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const intruderContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();
  const intruder = await intruderContext.newPage();
  await signIn(owner, "owner");
  await signIn(member, "member");
  await signIn(intruder, "intruder");

  await expect(
    owner.getByRole("heading", { name: "Direct Messages" }),
  ).toBeVisible();
  await owner.getByLabel("Find or start a Direct Message").fill("member");
  await owner.getByRole("button", { name: "member @member" }).click();
  await expect(owner.getByTestId("active-dm-name")).toHaveText("member");
  await expect(owner.getByText("member@example.com")).toHaveCount(0);
  await expect(member.getByRole("button", { name: "owner" })).toBeVisible();
  await expect(member.getByRole("img", { name: "owner avatar" })).toBeVisible();
  const singleDirectMessageRow = await member
    .getByRole("button", { name: "owner" })
    .boundingBox();
  expect(singleDirectMessageRow?.height).toBeLessThanOrEqual(48);
  await member.getByRole("button", { name: "owner" }).click();
  await expect(member.getByTestId("dm-realtime-status")).toHaveText(
    "Connected",
  );

  await owner.getByLabel("Find or start a Direct Message").fill("intruder");
  await owner.getByRole("button", { name: "intruder @intruder" }).click();
  await expect(owner.getByRole("button", { name: "member" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "intruder" })).toBeVisible();
  await expect(owner.getByRole("img", { name: "member avatar" })).toBeVisible();
  await expect(
    owner.getByRole("img", { name: "intruder avatar" }),
  ).toBeVisible();
  await owner.getByRole("button", { name: "member" }).click();

  const directMessageId = await owner
    .getByRole("button", { name: "member" })
    .getAttribute("data-direct-message-id");
  expect(directMessageId).toBeTruthy();

  await owner.getByLabel("Find or start a Direct Message").fill("@member");
  await owner.getByRole("button", { name: "member @member" }).click();
  await expect(owner.getByRole("button", { name: "member" })).toHaveCount(1);
  await expect(owner.getByRole("button", { name: "member" })).toHaveAttribute(
    "data-direct-message-id",
    directMessageId ?? "",
  );

  const groupStatus = await owner.evaluate(
    async ({ apiOrigin }) =>
      (
        await fetch(`${apiOrigin}/api/direct-messages`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            participantHandles: ["@owner", "@member", "@intruder"],
          }),
        })
      ).status,
    { apiOrigin: harness.apiOrigin },
  );
  expect([400, 422]).toContain(groupStatus);

  await intruder.evaluate(
    ({ apiOrigin }) => {
      const events: unknown[] = [];
      Object.assign(window, { __directMessageEvents: events });
      const socket = new WebSocket(
        `${apiOrigin.replace(/^http/, "ws")}/api/direct-messages/events`,
      );
      socket.addEventListener("message", (event) => {
        events.push(JSON.parse(String(event.data)));
      });
      Object.assign(window, { __directMessageSocket: socket });
    },
    { apiOrigin: harness.apiOrigin },
  );

  await owner.getByLabel("Message member").fill("private hello");
  await owner.getByRole("button", { name: "Send Direct Message" }).click();
  await expect(
    member.getByText("private hello", { exact: true }),
  ).toBeVisible();
  await expect(
    intruder.getByText("private hello", { exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      intruder.evaluate(
        () =>
          (window as typeof window & { __directMessageEvents?: unknown[] })
            .__directMessageEvents?.length ?? 0,
      ),
    )
    .toBe(0);

  const firstMessageId = await owner
    .locator("[data-dm-message-id]", { hasText: "private hello" })
    .getAttribute("data-dm-message-id");
  expect(firstMessageId).toBeTruthy();
  const denied = await intruder.evaluate(
    async ({ apiOrigin, directMessageId, messageId }) => {
      const list = await fetch(`${apiOrigin}/api/direct-messages`, {
        credentials: "include",
      });
      const page = await fetch(
        `${apiOrigin}/api/direct-messages/${directMessageId}/messages`,
        { credentials: "include" },
      );
      const message = await fetch(
        `${apiOrigin}/api/direct-messages/${directMessageId}/messages/${messageId}`,
        { credentials: "include" },
      );
      const search = await fetch(
        `${apiOrigin}/api/direct-messages/${directMessageId}/search?q=private`,
        { credentials: "include" },
      );
      const audit = await fetch(
        `${apiOrigin}/api/direct-messages/${directMessageId}/audit`,
        { credentials: "include" },
      );
      return {
        list: await list.json(),
        pageStatus: page.status,
        messageStatus: message.status,
        searchStatus: search.status,
        auditStatus: audit.status,
      };
    },
    {
      apiOrigin: harness.apiOrigin,
      directMessageId,
      messageId: firstMessageId,
    },
  );
  expect(denied.list).toEqual([
    expect.objectContaining({ peerHandle: "owner" }),
  ]);
  expect(
    (denied.list as { id: string }[]).map((directMessage) => directMessage.id),
  ).not.toContain(directMessageId);
  expect(denied.pageStatus).toBe(404);
  expect(denied.messageStatus).toBe(404);
  expect(denied.searchStatus).toBe(404);
  expect(denied.auditStatus).toBe(404);

  await member
    .locator("[data-dm-message-id]", { hasText: "private hello" })
    .getByRole("button", { name: "Reply to owner" })
    .click();
  await member.getByLabel("Message owner").fill("private reply");
  await member.getByRole("button", { name: "Send Direct Message" }).click();
  const reply = owner.locator("[data-dm-message-id]", {
    hasText: "private reply",
  });
  await expect(reply).toContainText("private hello");
  const replyId = await reply.getAttribute("data-dm-message-id");
  expect(replyId).toBeTruthy();

  const ownerEditStatus = await owner.evaluate(
    async ({ apiOrigin, directMessageId, messageId }) =>
      (
        await fetch(
          `${apiOrigin}/api/direct-messages/${directMessageId}/messages/${messageId}`,
          {
            method: "PATCH",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: "forbidden edit" }),
          },
        )
      ).status,
    { apiOrigin: harness.apiOrigin, directMessageId, messageId: replyId },
  );
  expect(ownerEditStatus).toBe(403);

  const memberReply = member.locator(`[data-dm-message-id="${replyId}"]`);
  await memberReply
    .getByRole("button", { name: "Edit message by member" })
    .click();
  await memberReply
    .getByRole("textbox", { name: "Edit message by member" })
    .fill("private reply edited");
  await memberReply.getByRole("button", { name: "Save edit" }).click();
  await expect(reply).toContainText("private reply edited");

  await reply.getByRole("button", { name: "React with 👍" }).click();
  await expect(
    memberReply.getByRole("button", { name: "React with 👍" }),
  ).toContainText("1");
  await reply.getByRole("button", { name: "React with 👍" }).click();
  await expect(
    memberReply.getByRole("button", { name: "React with 👍" }),
  ).toHaveText("👍");
  await reply.getByRole("button", { name: "React with 👍" }).click();
  await expect(
    memberReply.getByRole("button", { name: "React with 👍" }),
  ).toContainText("1");

  const participantSearch = await owner.evaluate(
    async ({ apiOrigin, directMessageId }) => {
      const response = await fetch(
        `${apiOrigin}/api/direct-messages/${directMessageId}/search?q=edited`,
        { credentials: "include" },
      );
      return { status: response.status, body: await response.json() };
    },
    { apiOrigin: harness.apiOrigin, directMessageId },
  );
  expect(participantSearch.status).toBe(200);
  expect(participantSearch.body).toHaveLength(1);

  const ownerFirstMessage = owner.locator(
    `[data-dm-message-id="${firstMessageId}"]`,
  );
  await ownerFirstMessage
    .getByRole("button", { name: "Delete message by owner" })
    .click();
  await expect(
    member.locator(`[data-dm-message-id="${firstMessageId}"]`),
  ).toContainText("Message deleted");

  await owner.getByLabel("Message member").fill("reaction deletion race");
  await owner.getByRole("button", { name: "Send Direct Message" }).click();
  const racedMessageId = await owner
    .locator("[data-dm-message-id]", { hasText: "reaction deletion race" })
    .getAttribute("data-dm-message-id");
  expect(racedMessageId).toBeTruthy();
  const racedResult = await owner.evaluate(
    async ({ apiOrigin, directMessageId, messageId }) => {
      const messageUrl = `${apiOrigin}/api/direct-messages/${directMessageId}/messages/${messageId}`;
      const [reaction, deletion] = await Promise.all([
        fetch(`${messageUrl}/reactions`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ emoji: "👍" }),
        }),
        fetch(messageUrl, { method: "DELETE", credentials: "include" }),
      ]);
      const readback = await fetch(messageUrl, { credentials: "include" });
      return {
        reactionStatus: reaction.status,
        deletionStatus: deletion.status,
        message: await readback.json(),
      };
    },
    {
      apiOrigin: harness.apiOrigin,
      directMessageId,
      messageId: racedMessageId,
    },
  );
  expect([200, 404]).toContain(racedResult.reactionStatus);
  expect(racedResult.deletionStatus).toBe(200);
  expect(racedResult.message.deletedAt).toBeTruthy();
  expect(racedResult.message.reactions).toEqual([]);

  const auditActions = await member.evaluate(
    async ({ apiOrigin, directMessageId }) => {
      const response = await fetch(
        `${apiOrigin}/api/direct-messages/${directMessageId}/audit`,
        { credentials: "include" },
      );
      return (await response.json()).map(
        (entry: { action: string }) => entry.action,
      );
    },
    { apiOrigin: harness.apiOrigin, directMessageId },
  );
  expect(auditActions).toEqual(
    expect.arrayContaining([
      "message.edited",
      "message.deleted",
      "reaction.added",
      "reaction.removed",
    ]),
  );

  await harness.restartServer();
  await expect(member.getByTestId("dm-realtime-status")).toHaveText(
    "Connected",
    { timeout: 10_000 },
  );
  await expect(
    member.locator(`[data-dm-message-id="${replyId}"]`),
  ).toContainText("private reply edited");
  await expect(
    memberReply.getByRole("button", { name: "React with 👍" }),
  ).toContainText("1");
  await expect(
    member.locator(`[data-dm-message-id="${firstMessageId}"]`),
  ).toContainText("Message deleted");

  await intruderContext.close();
  await memberContext.close();
  await ownerContext.close();
});

test("finds people by Display Name and distinguishes duplicate names by username", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const firstAliceContext = await browser.newContext();
  const secondAliceContext = await browser.newContext();
  const hiddenAliceContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const firstAlice = await firstAliceContext.newPage();
  const secondAlice = await secondAliceContext.newPage();
  const hiddenAlice = await hiddenAliceContext.newPage();

  await signIn(owner, "owner");
  await owner.getByLabel("Server name").fill("People Search Server");
  await owner.getByRole("button", { name: "Create Server" }).click();
  await expect(owner.getByTestId("active-server-name")).toHaveText(
    "People Search Server",
  );

  await openServerSettings(owner);
  await owner.getByLabel("Invite email").fill("alice_one@example.com");
  await owner.getByRole("button", { name: "Create invitation" }).click();
  const firstInvitation = await owner
    .getByTestId("invitation-code")
    .textContent();
  await signIn(firstAlice, "alice_one");
  await firstAlice.getByLabel("Invitation code").fill(firstInvitation ?? "");
  await firstAlice.getByRole("button", { name: "Join Server" }).click();
  await expect(firstAlice.getByTestId("active-server-name")).toHaveText(
    "People Search Server",
  );

  await owner.getByLabel("Invite email").fill("alice_two@example.com");
  await owner.getByRole("button", { name: "Create invitation" }).click();
  const secondInvitationOutput = owner.getByTestId("invitation-code");
  await expect(secondInvitationOutput).not.toHaveText(firstInvitation ?? "");
  const secondInvitation = await secondInvitationOutput.textContent();
  await signIn(secondAlice, "alice_two");
  await secondAlice.getByLabel("Invitation code").fill(secondInvitation ?? "");
  await secondAlice.getByRole("button", { name: "Join Server" }).click();
  await expect(secondAlice.getByTestId("active-server-name")).toHaveText(
    "People Search Server",
  );
  await closeServerSettings(owner);

  await signIn(hiddenAlice, "alice_hidden");

  const peopleSearch = await owner.evaluate(
    async ({ apiOrigin }) => {
      const response = await fetch(`${apiOrigin}/api/users/search?q=Alice`, {
        credentials: "include",
      });
      return { status: response.status, body: await response.text() };
    },
    { apiOrigin: harness.apiOrigin },
  );
  expect(peopleSearch.status, peopleSearch.body).toBe(200);
  expect(
    (JSON.parse(peopleSearch.body) as { handle: string }[]).map(
      ({ handle }) => handle,
    ),
  ).toEqual(["alice_one", "alice_two"]);

  await owner.getByRole("button", { name: "Home" }).click();
  await owner.setViewportSize({ width: 700, height: 720 });
  await expect(owner.getByTestId("home-sidebar")).toBeHidden();
  await owner.getByRole("button", { name: "Toggle Direct Messages" }).click();
  await expect(owner.getByTestId("home-sidebar")).toBeVisible();
  await owner.getByLabel("Find or start a Direct Message").fill("Alice");
  await expect(
    owner.getByRole("button", { name: "Alice @alice_one" }),
  ).toBeVisible();
  await expect(
    owner.getByRole("button", { name: "Alice @alice_two" }),
  ).toBeVisible();
  await expect(
    owner.getByRole("button", { name: "Alice @alice_hidden" }),
  ).toHaveCount(0);

  await owner.getByRole("button", { name: "Alice @alice_two" }).click();
  await expect(owner.getByTestId("active-dm-name")).toHaveText("Alice");
  await expect(owner.getByTestId("home-sidebar")).toBeHidden();

  await owner.getByRole("button", { name: "Toggle Direct Messages" }).click();
  await owner.getByLabel("Find or start a Direct Message").fill("Alice");
  await owner.getByRole("button", { name: "Alice @alice_one" }).click();
  await expect(owner.getByTestId("active-dm-name")).toHaveText(
    "Alice @alice_one",
  );
  await owner.setViewportSize({ width: 1280, height: 720 });
  await expect(
    owner.getByRole("navigation", { name: "Direct Messages" }),
  ).toContainText("Alice @alice_one");
  await expect(
    owner.getByRole("navigation", { name: "Direct Messages" }),
  ).toContainText("Alice @alice_two");

  const legacyHandleStatus = await owner.evaluate(
    async ({ apiOrigin }) =>
      (
        await fetch(`${apiOrigin}/api/direct-messages`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ peerHandle: "alice_two" }),
        })
      ).status,
    { apiOrigin: harness.apiOrigin },
  );
  expect([400, 422]).toContain(legacyHandleStatus);

  const mismatchedIdentityStatus = await owner.evaluate(
    async ({ apiOrigin }) =>
      (
        await fetch(`${apiOrigin}/api/direct-messages`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            peerUserId: "rauthy-alice_two",
            peerHandle: "alice_one",
          }),
        })
      ).status,
    { apiOrigin: harness.apiOrigin },
  );
  expect(mismatchedIdentityStatus).toBe(404);

  await ownerContext.close();
  await firstAliceContext.close();
  await secondAliceContext.close();
  await hiddenAliceContext.close();
});
