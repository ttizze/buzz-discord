import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { E2eHarness } from "./harness";

const harness = new E2eHarness();
const hostBinary = resolve(
  import.meta.dirname,
  "../../target/debug/buzzcode-host",
);

async function stopHost(host: ChildProcess | undefined): Promise<void> {
  if (host === undefined || host.exitCode !== null || host.signalCode !== null)
    return;
  const exited = new Promise<void>((done) => host.once("exit", () => done()));
  host.kill("SIGTERM");
  await exited;
}

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

test("adds the selected folder as an Open Project without asking for a name", async ({
  browser,
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "buzzcode-project-e2e-"));
  const folderPath = join(directory, "ordinary-folder");
  const otherFolderPath = join(directory, "other-computer-folder");
  const statePath = join(directory, "desktop-host.json");
  const otherStatePath = join(directory, "other-host.json");
  let host: ChildProcess | undefined;
  let otherHost: ChildProcess | undefined;
  await mkdir(folderPath);
  await mkdir(join(folderPath, "src"));
  await writeFile(join(folderPath, "README.md"), "Bound Computer file\n");
  await mkdir(otherFolderPath);
  const canonicalFolderPath = await realpath(folderPath);
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

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as Window & {
                __BUZZCODE_E2E_COMPUTER_REGISTRATION__?: {
                  id: string;
                  credential: string;
                };
              }
            ).__BUZZCODE_E2E_COMPUTER_REGISTRATION__,
        ),
      )
      .not.toBeUndefined();
    const registration = await page.evaluate(
      () =>
        (
          window as Window & {
            __BUZZCODE_E2E_COMPUTER_REGISTRATION__?: {
              id: string;
              credential: string;
            };
          }
        ).__BUZZCODE_E2E_COMPUTER_REGISTRATION__,
    );
    expect(registration).toBeDefined();
    if (registration === undefined)
      throw new Error("Computer did not register");
    await writeFile(
      statePath,
      JSON.stringify({
        computerId: registration.id,
        apiOrigin: harness.apiOrigin,
        credential: registration.credential,
        installationId: "owner-mac-installation",
        name: "Owner Mac",
      }),
    );
    host = spawn(hostBinary, ["run", "--state", statePath], {
      stdio: "ignore",
    });
    await expect
      .poll(async () => {
        const computers = await page.evaluate(
          async (origin) =>
            (
              await fetch(`${origin}/api/computers`, {
                credentials: "include",
              })
            ).json(),
          harness.apiOrigin,
        );
        return computers.find(
          (computer: { id: string }) => computer.id === registration.id,
        )?.status;
      })
      .toBe("online");

    await expect(
      page.getByRole("button", { name: "Add Project" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Add Project" }).click();
    await expect(page.getByLabel("Project name")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "ordinary-folder" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Open Project ordinary-folder" })
      .click();
    await expect(page.getByTestId("active-project-name")).toHaveText(
      "ordinary-folder",
    );
    await expect(
      page.getByRole("list", { name: "Project files" }),
    ).toContainText("README.md");
    await expect(
      page.getByRole("list", { name: "Project files" }),
    ).toContainText("src");
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
          name: "ordinary-folder",
          computerId: expect.any(String),
          computerName: "Owner Mac",
          computerStatus: "online",
          folderPath: canonicalFolderPath,
          visibility: "open",
          channels: [],
        }),
      ],
    });

    const otherComputer = await page.evaluate(async (origin) => {
      const pairingCode = await (
        await fetch(`${origin}/api/host-pairing-codes`, {
          method: "POST",
          credentials: "include",
        })
      ).json();
      return (
        await fetch(`${origin}/api/hosts/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pairingCode: pairingCode.code,
            installationId: "other-computer-installation",
            name: "Other Computer",
          }),
        })
      ).json();
    }, harness.apiOrigin);
    await writeFile(
      otherStatePath,
      JSON.stringify({
        computerId: otherComputer.computerId,
        apiOrigin: harness.apiOrigin,
        credential: otherComputer.credential,
        installationId: "other-computer-installation",
        name: "Other Computer",
      }),
    );
    otherHost = spawn(hostBinary, ["run", "--state", otherStatePath], {
      stdio: "ignore",
    });
    await expect
      .poll(async () =>
        page.evaluate(
          async ({ computerId, origin }) => {
            const computers = await (
              await fetch(`${origin}/api/computers`, {
                credentials: "include",
              })
            ).json();
            return computers.find(
              (computer: { id: string }) => computer.id === computerId,
            )?.status;
          },
          { computerId: otherComputer.computerId, origin: harness.apiOrigin },
        ),
      )
      .toBe("online");
    const selectedOtherComputerStatus = await page.evaluate(
      async ({
        computerCredential,
        computerId,
        folderPath,
        origin,
        serverId,
      }) =>
        (
          await fetch(`${origin}/api/servers/${serverId}/projects`, {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/json",
              "x-buzzcode-computer-credential": computerCredential,
            },
            body: JSON.stringify({ computerId, folderPath }),
          })
        ).status,
      {
        computerCredential: registration.credential,
        computerId: otherComputer.computerId,
        folderPath: otherFolderPath,
        origin: harness.apiOrigin,
        serverId,
      },
    );
    expect(selectedOtherComputerStatus).toBe(422);

    const firstProject = projects.body[0];
    const secondServer = await page.evaluate(
      async ({ computerCredential, folderPath, origin }) => {
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
            headers: {
              "content-type": "application/json",
              "x-buzzcode-computer-credential": computerCredential,
            },
            body: JSON.stringify({ folderPath }),
          },
        );
        return {
          status: projectResponse.status,
          body: await projectResponse.json(),
        };
      },
      {
        computerCredential: registration.credential,
        folderPath,
        origin: harness.apiOrigin,
      },
    );
    expect(secondServer).toEqual({
      status: 201,
      body: expect.objectContaining({
        computerId: firstProject.computerId,
        folderPath: canonicalFolderPath,
      }),
    });

    await page
      .getByRole("button", { name: "Add Channel to ordinary-folder" })
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
        member.getByRole("heading", { name: "ordinary-folder" }),
      ).toBeVisible();
      await expect(
        member.getByRole("button", { name: "implementation" }),
      ).toBeVisible();
      await member
        .getByRole("button", { name: "Open Project ordinary-folder" })
        .click();
      await expect(
        member.getByRole("list", { name: "Project files" }),
      ).toContainText("README.md");
      await expect(
        member.getByRole("button", { name: "Add Project" }),
      ).toHaveCount(0);
      const forbidden = await member.evaluate(
        async ({ folderPath, origin, projectId, serverId }) => {
          const projectStatus = (
            await fetch(`${origin}/api/servers/${serverId}/projects`, {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ folderPath }),
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
          folderPath,
          origin: harness.apiOrigin,
          projectId: firstProject.id,
          serverId,
        },
      );
      expect(forbidden).toEqual({
        channelStatus: 403,
        projectStatus: 403,
      });
    } finally {
      await memberContext.close();
    }

    await stopHost(host);
    host = undefined;
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
    await page
      .getByRole("button", { name: "Open Project ordinary-folder" })
      .click();
    await expect(
      page.getByText("Files are unavailable while Owner Mac is offline."),
    ).toBeVisible();
    const offlineAgents = await page.evaluate(
      async ({ channelId, origin, serverId }) =>
        (
          await fetch(
            `${origin}/api/servers/${serverId}/channels/${channelId}/agent-mention-suggestions?q=codex`,
            { credentials: "include" },
          )
        ).json(),
      { channelId: channel.id, origin: harness.apiOrigin, serverId },
    );
    expect(offlineAgents).toEqual([]);
    await expect(
      page.getByRole("button", { name: "Add Project" }),
    ).toBeDisabled();
  } finally {
    await stopHost(host);
    await stopHost(otherHost);
    await rm(directory, { recursive: true, force: true });
  }
});
