import { type ChildProcess, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { E2eHarness } from "./harness";

const harness = new E2eHarness();
const hostBinary = resolve(
  import.meta.dirname,
  "../../target/debug/buzzcode-host",
);
const fixtureAgent = resolve(
  import.meta.dirname,
  "fixtures/acp-echo-agent.mjs",
);

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  await exited;
}

test.beforeAll(async () => harness.start());
test.afterAll(async () => harness.stop());

test("routes a Project Channel Agent Mention through its bound Computer over ACP v1", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "buzzcode-agent-run-e2e-"));
  const projectFolder = join(directory, "selected-folder");
  const hostState = join(directory, "host.json");
  await mkdir(projectFolder);
  const canonicalProjectFolder = await realpath(projectFolder);
  await chmod(fixtureAgent, 0o755);

  await page.goto(harness.applicationUrl);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await page.getByLabel("Server name").fill("Agent Project Server");
  await page.getByRole("button", { name: "Create Server" }).click();
  const serverId = await page
    .getByRole("button", { name: "Agent Project Server" })
    .getAttribute("data-server-id");
  expect(serverId).toBeTruthy();

  const pairing = await page.evaluate(async (origin) => {
    const code = await (
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
          pairingCode: code.code,
          installationId: "agent-run-host",
          name: "Agent Run Host",
        }),
      })
    ).json();
  }, harness.apiOrigin);
  await writeFile(
    hostState,
    JSON.stringify({
      computerId: pairing.computerId,
      apiOrigin: harness.apiOrigin,
      credential: pairing.credential,
      installationId: "agent-run-host",
      name: "Agent Run Host",
    }),
  );
  const host = spawn(
    hostBinary,
    ["run", "--state", hostState, "--codex-command", fixtureAgent],
    { stdio: "ignore" },
  );

  try {
    await expect
      .poll(async () =>
        page.evaluate(
          async ({ computerId, origin }) => {
            const computers = await (
              await fetch(`${origin}/api/computers`, { credentials: "include" })
            ).json();
            return computers.find(
              (computer: { id: string }) => computer.id === computerId,
            )?.status;
          },
          { computerId: pairing.computerId, origin: harness.apiOrigin },
        ),
      )
      .toBe("online");
    const created = await page.evaluate(
      async ({ computerId, folderPath, origin, serverId }) => {
        const projectResponse = await fetch(
          `${origin}/api/servers/${serverId}/projects`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              computerId,
              folderPath,
            }),
          },
        );
        const project = await projectResponse.json();
        const channelResponse = await fetch(
          `${origin}/api/servers/${serverId}/projects/${project.id}/channels`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "agent-work" }),
          },
        );
        return {
          projectStatus: projectResponse.status,
          project,
          channel: await channelResponse.json(),
        };
      },
      {
        computerId: pairing.computerId,
        folderPath: projectFolder,
        origin: harness.apiOrigin,
        serverId,
      },
    );
    expect(created.projectStatus).toBe(201);
    await page.reload();
    await page.getByRole("button", { name: "agent-work" }).click();
    await page.getByLabel("Message #agent-work").fill("@codex");
    await expect(
      page.getByRole("button", { name: /Codex.*@codex/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Codex.*@codex/ }).click();
    await page.getByLabel("Message #agent-work").fill("@Codex report context");
    await page.getByRole("button", { name: "Send" }).click();

    const agentMessage = page
      .locator("[data-message-author-kind='agent']")
      .filter({ hasText: `cwd=${canonicalProjectFolder}` });
    await expect(agentMessage).toContainText("prompt=report context", {
      timeout: 20_000,
    });
    await expect(agentMessage).toContainText("Codex");
  } finally {
    await stop(host);
    await rm(directory, { recursive: true, force: true });
  }
});
