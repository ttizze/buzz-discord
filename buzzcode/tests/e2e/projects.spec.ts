import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { E2eHarness } from "./harness";

const harness = new E2eHarness();
const hostBinary = resolve(
  import.meta.dirname,
  "../../target/debug/buzzcode-host",
);

test.beforeAll(async () => {
  await harness.start();
});

test.afterAll(async () => {
  await harness.stop();
});

async function stopHost(host: ChildProcess): Promise<void> {
  if (host.exitCode !== null || host.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) =>
    host.once("exit", () => resolveExit()),
  );
  host.kill("SIGTERM");
  await exited;
}

async function signIn(page: Page, user: string): Promise<void> {
  await fetch(`${harness.identityProviderOrigin}/test/next-token?user=${user}`);
  await page.goto(harness.applicationUrl);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.getByRole("button", { name: "Continue with passkey" }).click();
}

test("an Online Host exposes Git repositories for Open Project creation", async ({
  browser,
  page,
}) => {
  await page.goto(harness.applicationUrl);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await page.getByLabel("Server name").fill("Project Server");
  await page.getByRole("button", { name: "Create Server" }).click();
  const serverId = await page
    .getByRole("button", { name: "Project Server" })
    .getAttribute("data-server-id");
  expect(serverId).toBeTruthy();

  const pairing = await page.evaluate(
    async ({ id, origin }) => {
      const codeResponse = await fetch(
        `${origin}/api/servers/${id}/host-pairing-codes`,
        { method: "POST", credentials: "include" },
      );
      const { code } = await codeResponse.json();
      const pairResponse = await fetch(`${origin}/api/hosts/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pairingCode: code,
          installationId: "project-host-installation",
          name: "Project VPS",
        }),
      });
      return pairResponse.json();
    },
    { id: serverId, origin: harness.apiOrigin },
  );

  const directory = await mkdtemp(join(tmpdir(), "buzzcode-project-e2e-"));
  const repositoryPath = join(directory, "sample-repository");
  const nonGitPath = join(directory, "ordinary-folder");
  await mkdir(nonGitPath);
  const git = spawnSync("git", ["init", "--quiet", repositoryPath]);
  expect(git.status).toBe(0);
  const exposedRepositoryPath = await realpath(repositoryPath);
  const statePath = join(directory, "host.json");
  await writeFile(
    statePath,
    JSON.stringify({
      remoteEnvironmentId: pairing.id,
      serverId: pairing.serverId,
      apiOrigin: harness.apiOrigin,
      credential: pairing.credential,
      installationId: "project-host-installation",
      name: "Project VPS",
    }),
  );

  await expect(
    page.getByRole("button", { name: "Add Project" }),
  ).toBeDisabled();

  const offlineStatus = await page.evaluate(
    async ({ environmentId, id, origin, repositoryPath }) =>
      (
        await fetch(`${origin}/api/servers/${id}/projects`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Offline Project",
            remoteEnvironmentId: environmentId,
            repositoryPath,
          }),
        })
      ).status,
    {
      environmentId: pairing.id,
      id: serverId,
      origin: harness.apiOrigin,
      repositoryPath,
    },
  );
  expect(offlineStatus).toBe(409);

  const host = spawn(
    hostBinary,
    [
      "run",
      "--state",
      statePath,
      "--repository",
      repositoryPath,
      "--repository",
      nonGitPath,
    ],
    { stdio: "ignore" },
  );
  try {
    await expect
      .poll(async () => {
        const environments = await page.evaluate(
          async ({ id, origin }) =>
            (
              await fetch(`${origin}/api/servers/${id}/remote-environments`, {
                credentials: "include",
              })
            ).json(),
          { id: serverId, origin: harness.apiOrigin },
        );
        return environments.find(
          (environment: { id: string; status: string }) =>
            environment.id === pairing.id,
        )?.status;
      })
      .toBe("online");
    await expect(
      page.getByRole("button", { name: "Add Project" }),
    ).toBeEnabled();

    const repositories = await page.evaluate(
      async ({ environmentId, id, origin }) => {
        const response = await fetch(
          `${origin}/api/servers/${id}/remote-environments/${environmentId}/repositories`,
          { credentials: "include" },
        );
        return { status: response.status, body: await response.json() };
      },
      { environmentId: pairing.id, id: serverId, origin: harness.apiOrigin },
    );
    expect(repositories).toEqual({
      status: 200,
      body: [
        {
          name: basename(exposedRepositoryPath),
          path: exposedRepositoryPath,
        },
      ],
    });

    const nonGitStatus = await page.evaluate(
      async ({ environmentId, id, origin, repositoryPath }) =>
        (
          await fetch(`${origin}/api/servers/${id}/projects`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: "Not Git",
              remoteEnvironmentId: environmentId,
              repositoryPath,
            }),
          })
        ).status,
      {
        environmentId: pairing.id,
        id: serverId,
        origin: harness.apiOrigin,
        repositoryPath: nonGitPath,
      },
    );
    expect(nonGitStatus).toBe(400);

    const created = await page.evaluate(
      async ({ environmentId, id, origin, repositoryPath }) => {
        const response = await fetch(`${origin}/api/servers/${id}/projects`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Buzzcode",
            remoteEnvironmentId: environmentId,
            repositoryPath,
          }),
        });
        return { status: response.status, body: await response.json() };
      },
      {
        environmentId: pairing.id,
        id: serverId,
        origin: harness.apiOrigin,
        repositoryPath: exposedRepositoryPath,
      },
    );
    expect(created).toEqual({
      status: 201,
      body: expect.objectContaining({
        name: "Buzzcode",
        remoteEnvironmentId: pairing.id,
        repositoryPath: exposedRepositoryPath,
        visibility: "open",
        channels: [],
      }),
    });

    const projects = await page.evaluate(
      async ({ id, origin }) =>
        (
          await fetch(`${origin}/api/servers/${id}/projects`, {
            credentials: "include",
          })
        ).json(),
      { id: serverId, origin: harness.apiOrigin },
    );
    expect(projects).toEqual([created.body]);
    await expect(page.getByRole("heading", { name: "Buzzcode" })).toBeVisible();

    await page.getByRole("button", { name: "Add Project" }).click();
    await expect(
      page.getByRole("dialog", { name: "Create Open Project" }),
    ).toBeVisible();
    await expect(page.getByLabel("Git repository")).toBeDisabled();
    await page.getByLabel("Project name").fill("Desktop Project");
    await page
      .getByLabel("Remote Environment")
      .selectOption({ label: "Project VPS" });
    await expect(page.getByLabel("Git repository")).toBeEnabled();
    await page.getByLabel("Git repository").selectOption(exposedRepositoryPath);
    await page
      .getByRole("button", { name: "Create Open Project", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Desktop Project" }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Add Channel to Desktop Project" })
      .click();
    await page.getByLabel("Project Channel name").fill("design");
    await page
      .getByRole("button", { name: "Create Project Channel", exact: true })
      .click();
    await expect(page.getByTestId("active-channel-name")).toHaveText(
      "# design",
    );

    const projectChannel = await page.evaluate(
      async ({ id, origin, projectId }) => {
        const response = await fetch(
          `${origin}/api/servers/${id}/projects/${projectId}/channels`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "implementation" }),
          },
        );
        const text = await response.text();
        return {
          status: response.status,
          body: text === "" ? {} : JSON.parse(text),
        };
      },
      { id: serverId, origin: harness.apiOrigin, projectId: created.body.id },
    );
    expect(projectChannel).toEqual({
      status: 201,
      body: expect.objectContaining({
        name: "implementation",
        visibility: "open",
      }),
    });

    const directChannels = await page.evaluate(
      async ({ id, origin }) =>
        (
          await fetch(`${origin}/api/servers/${id}/channels`, {
            credentials: "include",
          })
        ).json(),
      { id: serverId, origin: harness.apiOrigin },
    );
    expect(directChannels).toEqual([]);

    const moveOrVisibilityChange = await page.evaluate(
      async ({ channelId, id, origin }) =>
        (
          await fetch(`${origin}/api/servers/${id}/channels/${channelId}`, {
            method: "PATCH",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ visibility: "private" }),
          })
        ).status,
      {
        channelId: projectChannel.body.id,
        id: serverId,
        origin: harness.apiOrigin,
      },
    );
    expect(moveOrVisibilityChange).toBe(409);

    const invitation = await page.evaluate(
      async ({ id, origin }) =>
        (
          await fetch(`${origin}/api/servers/${id}/invitations`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "member@example.com" }),
          })
        ).json(),
      { id: serverId, origin: harness.apiOrigin },
    );
    const memberContext = await browser.newContext();
    try {
      const member = await memberContext.newPage();
      await signIn(member, "member");
      await member.getByLabel("Invitation code").fill(invitation.token);
      await member.getByRole("button", { name: "Join Server" }).click();
      await expect(
        member.getByRole("heading", { name: "Buzzcode" }),
      ).toBeVisible();
      await expect(
        member.getByRole("heading", { name: "Desktop Project" }),
      ).toBeVisible();
      await expect(
        member.getByRole("button", { name: "implementation" }),
      ).toBeVisible();
      await expect(
        member.getByRole("button", { name: "design" }),
      ).toBeVisible();
      await expect(
        member.getByRole("button", { name: "Add Project" }),
      ).toHaveCount(0);
      await expect(
        member.getByRole("button", { name: /Add Channel to/ }),
      ).toHaveCount(0);

      const memberAccess = await member.evaluate(
        async ({ environmentId, id, origin, projectId, repositoryPath }) => {
          const listResponse = await fetch(
            `${origin}/api/servers/${id}/projects`,
            { credentials: "include" },
          );
          const createProjectResponse = await fetch(
            `${origin}/api/servers/${id}/projects`,
            {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                name: "Forbidden Project",
                remoteEnvironmentId: environmentId,
                repositoryPath,
              }),
            },
          );
          const createChannelResponse = await fetch(
            `${origin}/api/servers/${id}/projects/${projectId}/channels`,
            {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: "forbidden-channel" }),
            },
          );
          return {
            projects: await listResponse.json(),
            createProjectStatus: createProjectResponse.status,
            createChannelStatus: createChannelResponse.status,
          };
        },
        {
          environmentId: pairing.id,
          id: serverId,
          origin: harness.apiOrigin,
          projectId: created.body.id,
          repositoryPath: exposedRepositoryPath,
        },
      );
      expect(memberAccess.projects).toHaveLength(2);
      expect(memberAccess.projects[0].channels).toEqual([projectChannel.body]);
      expect(memberAccess.createProjectStatus).toBe(403);
      expect(memberAccess.createChannelStatus).toBe(403);
    } finally {
      await memberContext.close();
    }

    await stopHost(host);
    await expect
      .poll(async () => {
        const environments = await page.evaluate(
          async ({ id, origin }) =>
            (
              await fetch(`${origin}/api/servers/${id}/remote-environments`, {
                credentials: "include",
              })
            ).json(),
          { id: serverId, origin: harness.apiOrigin },
        );
        return environments.find(
          (environment: { id: string; status: string }) =>
            environment.id === pairing.id,
        )?.status;
      })
      .toBe("offline");

    const offlineMessage = await page.evaluate(
      async ({ channelId, id, origin }) => {
        const response = await fetch(
          `${origin}/api/servers/${id}/channels/${channelId}/messages`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: "Chat survives Host downtime" }),
          },
        );
        return { status: response.status, body: await response.json() };
      },
      {
        channelId: projectChannel.body.id,
        id: serverId,
        origin: harness.apiOrigin,
      },
    );
    expect(offlineMessage).toEqual({
      status: 201,
      body: expect.objectContaining({
        channelId: projectChannel.body.id,
        content: "Chat survives Host downtime",
      }),
    });
    await page
      .getByLabel("Message #design")
      .fill("Desktop chat also survives Host downtime");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.locator("[data-message-id]", {
        hasText: "Desktop chat also survives Host downtime",
      }),
    ).toBeVisible();

    const projectsWithChannel = await page.evaluate(
      async ({ id, origin }) =>
        (
          await fetch(`${origin}/api/servers/${id}/projects`, {
            credentials: "include",
          })
        ).json(),
      { id: serverId, origin: harness.apiOrigin },
    );
    expect(projectsWithChannel[0].channels).toEqual([projectChannel.body]);
  } finally {
    await stopHost(host);
    await rm(directory, { recursive: true, force: true });
  }
});
