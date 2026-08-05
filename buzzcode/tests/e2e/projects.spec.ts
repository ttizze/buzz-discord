import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { E2eHarness } from "./harness";

const harness = new E2eHarness();

async function signIn(page: Page, user: string): Promise<void> {
  await fetch(`${harness.identityProviderOrigin}/test/next-token?user=${user}`);
  await page.goto(harness.applicationUrl);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.getByRole("button", { name: "Continue with passkey" }).click();
}

test.beforeAll(async () => {
  await harness.start();
});

test.afterAll(async () => {
  await harness.stop();
});

test("adds an Open Project from a non-Git folder on the current Computer", async ({
  browser,
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "buzzcode-project-e2e-"));
  const folderPath = join(directory, "ordinary-folder");
  await mkdir(folderPath);
  await page.addInitScript(
    ({ selectedFolder }) => {
      (
        window as Window & {
          __BUZZCODE_E2E_COMPUTER__?: {
            installationId: string;
            name: string;
            selectedFolder: string;
          };
        }
      ).__BUZZCODE_E2E_COMPUTER__ = {
        installationId: "owner-mac-installation",
        name: "Owner Mac",
        selectedFolder,
      };
    },
    { selectedFolder: folderPath },
  );

  try {
    await page.goto(harness.applicationUrl);
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.getByRole("button", { name: "Continue with passkey" }).click();
    await page.getByLabel("Server name").fill("Project Server");
    await page.getByRole("button", { name: "Create Server" }).click();
    const serverId = await page
      .getByRole("button", { name: "Project Server" })
      .getAttribute("data-server-id");
    expect(serverId).toBeTruthy();

    await expect(
      page.getByRole("button", { name: "Add Project" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Add Project" }).click();
    await expect(
      page.getByRole("dialog", { name: "Create Open Project" }),
    ).toBeVisible();
    await expect(page.getByLabel("Remote Environment")).toHaveCount(0);
    await expect(page.getByLabel("Git repository")).toHaveCount(0);

    await page.getByLabel("Project name").fill("Local Folder Project");
    await page.getByRole("button", { name: "Choose Project Folder" }).click();
    await expect(page.getByTestId("selected-project-folder")).toHaveText(
      folderPath,
    );
    await page
      .getByRole("button", { name: "Create Open Project", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Local Folder Project" }),
    ).toBeVisible();

    const projects = await page.evaluate(
      async ({ id, origin }) => {
        const response = await fetch(`${origin}/api/servers/${id}/projects`, {
          credentials: "include",
        });
        return { status: response.status, body: await response.json() };
      },
      { id: serverId, origin: harness.apiOrigin },
    );
    expect(projects).toEqual({
      status: 200,
      body: [
        expect.objectContaining({
          name: "Local Folder Project",
          computerId: expect.any(String),
          computerName: "Owner Mac",
          computerStatus: "online",
          folderPath,
          visibility: "open",
          channels: [],
        }),
      ],
    });

    const firstProject = projects.body[0];
    const secondServer = await page.evaluate(
      async ({ computerId, folderPath, origin }) => {
        const serverResponse = await fetch(`${origin}/api/servers`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Second Server" }),
        });
        const server = await serverResponse.json();
        const projectResponse = await fetch(
          `${origin}/api/servers/${server.id}/projects`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: "Same Computer Project",
              computerId,
              folderPath,
            }),
          },
        );
        return {
          status: projectResponse.status,
          body: await projectResponse.json(),
        };
      },
      {
        computerId: firstProject.computerId,
        folderPath,
        origin: harness.apiOrigin,
      },
    );
    expect(secondServer).toEqual({
      status: 201,
      body: expect.objectContaining({
        computerId: firstProject.computerId,
        folderPath,
      }),
    });

    await page
      .getByRole("button", { name: "Add Channel to Local Folder Project" })
      .click();
    await page.getByLabel("Project Channel name").fill("implementation");
    await page
      .getByRole("button", { name: "Create Project Channel", exact: true })
      .click();
    await expect(page.getByTestId("active-channel-name")).toHaveText(
      "# implementation",
    );
    const channel = await page.evaluate(
      async ({ origin, serverId }) => {
        const projects = await (
          await fetch(`${origin}/api/servers/${serverId}/projects`, {
            credentials: "include",
          })
        ).json();
        return projects[0].channels[0];
      },
      { origin: harness.apiOrigin, serverId },
    );
    expect(channel).toEqual(
      expect.objectContaining({ name: "implementation", visibility: "open" }),
    );

    const placementGuards = await page.evaluate(
      async ({ channelId, origin, serverId }) => {
        const directChannels = await (
          await fetch(`${origin}/api/servers/${serverId}/channels`, {
            credentials: "include",
          })
        ).json();
        const visibilityStatus = (
          await fetch(
            `${origin}/api/servers/${serverId}/channels/${channelId}`,
            {
              method: "PATCH",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ visibility: "private" }),
            },
          )
        ).status;
        return { directChannels, visibilityStatus };
      },
      { channelId: channel.id, origin: harness.apiOrigin, serverId },
    );
    expect(placementGuards).toEqual({
      directChannels: [],
      visibilityStatus: 409,
    });

    const invitation = await page.evaluate(
      async ({ origin, serverId }) => {
        const response = await fetch(
          `${origin}/api/servers/${serverId}/invitations`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "member@example.com" }),
          },
        );
        return response.json();
      },
      { origin: harness.apiOrigin, serverId },
    );
    const memberContext = await browser.newContext();
    try {
      const member = await memberContext.newPage();
      await signIn(member, "member");
      await member.getByLabel("Invitation code").fill(invitation.token);
      await member.getByRole("button", { name: "Join Server" }).click();
      await expect(
        member.getByRole("heading", { name: "Local Folder Project" }),
      ).toBeVisible();
      await expect(
        member.getByRole("button", { name: "implementation" }),
      ).toBeVisible();
      await expect(
        member.getByRole("button", { name: "Add Project" }),
      ).toHaveCount(0);
      const forbidden = await member.evaluate(
        async ({ computerId, folderPath, origin, projectId, serverId }) => {
          const projectStatus = (
            await fetch(`${origin}/api/servers/${serverId}/projects`, {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                name: "Member Project",
                computerId,
                folderPath,
              }),
            })
          ).status;
          const channelStatus = (
            await fetch(
              `${origin}/api/servers/${serverId}/projects/${projectId}/channels`,
              {
                method: "POST",
                credentials: "include",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: "member-channel" }),
              },
            )
          ).status;
          return { channelStatus, projectStatus };
        },
        {
          computerId: firstProject.computerId,
          folderPath,
          origin: harness.apiOrigin,
          projectId: firstProject.id,
          serverId,
        },
      );
      expect(forbidden).toEqual({ channelStatus: 403, projectStatus: 403 });
    } finally {
      await memberContext.close();
    }

    await page.waitForTimeout(1_100);
    const offlineProject = await page.evaluate(
      async ({ channelId, origin, serverId }) => {
        const projectsResponse = await fetch(
          `${origin}/api/servers/${serverId}/projects`,
          { credentials: "include" },
        );
        const messageResponse = await fetch(
          `${origin}/api/servers/${serverId}/channels/${channelId}/messages`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              content: "Chat remains available while the Computer is Offline",
            }),
          },
        );
        return {
          projects: await projectsResponse.json(),
          messageStatus: messageResponse.status,
        };
      },
      {
        channelId: channel.id,
        origin: harness.apiOrigin,
        serverId,
      },
    );
    expect(offlineProject.messageStatus).toBe(201);
    expect(offlineProject.projects).toEqual([
      expect.objectContaining({
        id: firstProject.id,
        computerStatus: "offline",
        channels: [expect.objectContaining({ name: "implementation" })],
      }),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
