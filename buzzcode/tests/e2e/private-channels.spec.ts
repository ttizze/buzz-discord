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
}

async function inviteAndJoin(
  owner: Page,
  member: Page,
  user: string,
): Promise<void> {
  await openServerSettings(owner);
  const invitationOutput = owner.getByTestId("invitation-code");
  const previousInvitation =
    (await invitationOutput.count()) === 0
      ? ""
      : ((await invitationOutput.textContent()) ?? "");
  await owner.getByLabel("Invite email").fill(`${user}@example.com`);
  await owner.getByRole("button", { name: "Create invitation" }).click();
  if (previousInvitation !== "") {
    await expect(invitationOutput).not.toHaveText(previousInvitation);
  }
  const invitation = await invitationOutput.textContent();
  await signIn(member, user);
  await member.getByLabel("Invitation code").fill(invitation ?? "");
  await member.getByRole("button", { name: "Join Server" }).click();
  await expect(member.getByTestId("realtime-status")).toHaveText("Connected");
}

test("protects a Private direct server Channel at every access path", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const outsiderContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();
  const outsider = await outsiderContext.newPage();
  const admin = await adminContext.newPage();

  await signIn(owner, "owner");
  await owner.getByLabel("Server name").fill("Private Server");
  await owner.getByRole("button", { name: "Create Server" }).click();
  const serverId = await owner
    .getByRole("button", { name: "Private Server" })
    .getAttribute("data-server-id");
  expect(serverId).toBeTruthy();

  await inviteAndJoin(owner, member, "member");
  await inviteAndJoin(owner, outsider, "outsider");
  await inviteAndJoin(owner, admin, "admin");
  await owner.getByLabel("Role for @admin").selectOption("admin");
  await expect(admin.getByTestId("active-member-role")).toHaveText("Admin");

  await closeServerSettings(owner);
  await owner.getByRole("button", { name: "Add Channel" }).click();
  await owner.getByLabel("Channel name").fill("leadership");
  await owner.getByLabel("Channel visibility").selectOption("private");
  await owner.getByLabel("Allow member @member").check();
  await owner
    .getByRole("button", { name: "Create Channel", exact: true })
    .click();
  await expect(owner.getByTestId("active-channel-name")).toHaveText(
    "# leadership",
  );
  await expect(
    owner.getByText(
      "Private Channel · visible to selected Members and Server managers",
    ),
  ).toBeVisible();
  await expect(
    member.getByRole("button", { name: "leadership" }),
  ).toBeVisible();
  await expect(admin.getByRole("button", { name: "leadership" })).toBeVisible();
  await expect(
    outsider.getByRole("button", { name: "leadership" }),
  ).toHaveCount(0);

  const channelId = await owner
    .getByRole("button", { name: "leadership" })
    .getAttribute("data-channel-id");
  expect(channelId).toBeTruthy();
  await owner.getByLabel("Message #leadership").fill("private launch plan");
  await owner.getByRole("button", { name: "Send" }).click();
  await expect(
    member.getByText("private launch plan", { exact: true }),
  ).toBeVisible();
  await expect(
    admin.getByText("private launch plan", { exact: true }),
  ).toBeVisible();
  await expect(
    outsider.getByText("private launch plan", { exact: true }),
  ).toHaveCount(0);

  const messageId = await owner
    .locator("[data-message-id]", { hasText: "private launch plan" })
    .getAttribute("data-message-id");
  expect(messageId).toBeTruthy();
  const denied = await outsider.evaluate(
    async ({ apiOrigin, serverId, channelId, messageId }) => {
      const paths = [
        `/api/servers/${serverId}/channels/${channelId}/messages`,
        `/api/servers/${serverId}/channels/${channelId}/messages?before=999999`,
        `/api/servers/${serverId}/channels/${channelId}/messages/${messageId}`,
      ];
      const statuses = await Promise.all(
        paths.map(
          async (path) =>
            (await fetch(`${apiOrigin}${path}`, { credentials: "include" }))
              .status,
        ),
      );
      const postStatus = (
        await fetch(
          `${apiOrigin}/api/servers/${serverId}/channels/${channelId}/messages`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: "intrusion" }),
          },
        )
      ).status;
      const search = await fetch(
        `${apiOrigin}/api/servers/${serverId}/messages/search?q=private`,
        { credentials: "include" },
      );
      return {
        statuses,
        postStatus,
        searchStatus: search.status,
        searchBody: await search.json(),
      };
    },
    { apiOrigin: harness.apiOrigin, serverId, channelId, messageId },
  );
  expect(denied.statuses).toEqual([404, 404, 404]);
  expect(denied.postStatus).toBe(404);
  expect(denied.searchStatus).toBe(200);
  expect(denied.searchBody).toEqual([]);

  const placementStatus = await owner.evaluate(
    async ({ apiOrigin, serverId, channelId }) =>
      (
        await fetch(
          `${apiOrigin}/api/servers/${serverId}/channels/${channelId}`,
          {
            method: "PATCH",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ serverId: "another-server" }),
          },
        )
      ).status,
    { apiOrigin: harness.apiOrigin, serverId, channelId },
  );
  expect(placementStatus).toBe(422);

  const visibilityStatus = await owner.evaluate(
    async ({ apiOrigin, serverId, channelId }) =>
      (
        await fetch(
          `${apiOrigin}/api/servers/${serverId}/channels/${channelId}`,
          {
            method: "PATCH",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              visibility: "open",
              memberSubjects: [],
            }),
          },
        )
      ).status,
    { apiOrigin: harness.apiOrigin, serverId, channelId },
  );
  expect(visibilityStatus).toBe(409);

  await expect(owner.getByLabel("Allow outsider @outsider")).toHaveCount(0);
  await owner.getByRole("button", { name: "Edit Channel Access" }).click();
  await expect(
    owner.getByRole("dialog", { name: "Channel Access" }),
  ).toBeVisible();
  await owner.getByLabel("Allow outsider @outsider").check();
  await owner.getByRole("button", { name: "Save Channel access" }).click();
  await expect(
    owner.getByRole("dialog", { name: "Channel Access" }),
  ).toHaveCount(0);
  await expect(
    outsider.getByRole("button", { name: "leadership" }),
  ).toBeVisible();
  await owner.getByLabel("Message #leadership").fill("access granted live");
  await owner.getByRole("button", { name: "Send" }).click();
  await expect(
    outsider.getByText("access granted live", { exact: true }),
  ).toBeVisible();

  await owner.getByRole("button", { name: "Edit Channel Access" }).click();
  await owner.getByLabel("Allow outsider @outsider").uncheck();
  await owner.getByRole("button", { name: "Save Channel access" }).click();
  await expect(
    outsider.getByRole("button", { name: "leadership" }),
  ).toHaveCount(0);
  await expect(
    outsider.getByText("access granted live", { exact: true }),
  ).toHaveCount(0);
  const revokedStatus = await outsider.evaluate(
    async ({ apiOrigin, serverId, channelId }) =>
      (
        await fetch(
          `${apiOrigin}/api/servers/${serverId}/channels/${channelId}/messages`,
          { credentials: "include" },
        )
      ).status,
    { apiOrigin: harness.apiOrigin, serverId, channelId },
  );
  expect(revokedStatus).toBe(404);
  await openServerSettings(owner);
  await expect(owner.getByTestId("audit-history")).toContainText(
    "channel.access_changed",
  );

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const raceChannelId = await owner.evaluate(
      async ({ apiOrigin, serverId, attempt }) => {
        const response = await fetch(
          `${apiOrigin}/api/servers/${serverId}/channels`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: `race-${attempt}`,
              visibility: "open",
              memberSubjects: [],
            }),
          },
        );
        return ((await response.json()) as { id: string }).id;
      },
      { apiOrigin: harness.apiOrigin, serverId, attempt },
    );
    const [postStatus, visibilityRaceStatus] = await Promise.all([
      member.evaluate(
        async ({ apiOrigin, serverId, channelId }) =>
          (
            await fetch(
              `${apiOrigin}/api/servers/${serverId}/channels/${channelId}/messages`,
              {
                method: "POST",
                credentials: "include",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ content: "racing message" }),
              },
            )
          ).status,
        { apiOrigin: harness.apiOrigin, serverId, channelId: raceChannelId },
      ),
      owner.evaluate(
        async ({ apiOrigin, serverId, channelId }) =>
          (
            await fetch(
              `${apiOrigin}/api/servers/${serverId}/channels/${channelId}`,
              {
                method: "PATCH",
                credentials: "include",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  visibility: "private",
                  memberSubjects: [],
                }),
              },
            )
          ).status,
        { apiOrigin: harness.apiOrigin, serverId, channelId: raceChannelId },
      ),
    ]);
    expect(
      [
        [201, 409],
        [404, 200],
      ],
      `attempt ${attempt} must serialize message creation and visibility change`,
    ).toContainEqual([postStatus, visibilityRaceStatus]);
  }

  await adminContext.close();
  await outsiderContext.close();
  await memberContext.close();
  await ownerContext.close();
});
