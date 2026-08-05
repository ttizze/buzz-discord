import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { E2eHarness } from "./harness";
import { openServerSettings } from "./ui";

const harness = new E2eHarness();
const hostBinary = resolve(
  import.meta.dirname,
  "../../target/debug/buzzcode-host",
);

async function stopHost(host: ChildProcess): Promise<void> {
  if (host.exitCode !== null || host.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) =>
    host.once("exit", () => resolveExit()),
  );
  host.kill("SIGTERM");
  await exited;
}

test.beforeAll(async () => {
  await harness.start();
});

test.afterAll(async () => {
  await harness.stop();
});

test("pairs a VPS as a user Computer without binding it to one Server", async ({
  page,
}) => {
  await page.goto(harness.applicationUrl);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await page.getByLabel("Server name").fill("First Server");
  await page.getByRole("button", { name: "Create Server" }).click();

  const pairing = await page.evaluate(async (origin) => {
    const codeResponse = await fetch(`${origin}/api/host-pairing-codes`, {
      method: "POST",
      credentials: "include",
    });
    const codeBody = await codeResponse.json();
    const pairResponse = await fetch(`${origin}/api/hosts/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairingCode: codeBody.code,
        installationId: "vps-installation",
        name: "Shared VPS",
      }),
    });
    return {
      codeStatus: codeResponse.status,
      code: codeBody.code,
      pairStatus: pairResponse.status,
      paired: await pairResponse.json(),
    };
  }, harness.apiOrigin);
  expect(pairing.codeStatus).toBe(201);
  expect(pairing.pairStatus).toBe(201);
  expect(pairing.paired).toEqual({
    computerId: expect.any(String),
    credential: expect.any(String),
  });

  const replayStatus = await page.evaluate(
    async ({ code, origin }) =>
      (
        await fetch(`${origin}/api/hosts/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pairingCode: code,
            installationId: "replayed-installation",
            name: "Replay",
          }),
        })
      ).status,
    { code: pairing.code, origin: harness.apiOrigin },
  );
  expect(replayStatus).toBe(404);

  const directory = await mkdtemp(join(tmpdir(), "buzzcode-host-e2e-"));
  const firstFolder = join(directory, "first-vps-project");
  const secondFolder = join(directory, "second-vps-project");
  await mkdir(firstFolder);
  await mkdir(secondFolder);
  const statePath = join(directory, "host.json");
  await writeFile(
    statePath,
    JSON.stringify({
      // Existing paired Hosts keep working after the Computer-model migration.
      remoteEnvironmentId: pairing.paired.computerId,
      apiOrigin: harness.apiOrigin,
      credential: pairing.paired.credential,
      installationId: "vps-installation",
      name: "Shared VPS",
    }),
  );
  let host = spawn(hostBinary, ["run", "--state", statePath], {
    stdio: "ignore",
  });
  const computerStatus = async () => {
    const result = await page.evaluate(async (origin) => {
      const response = await fetch(`${origin}/api/computers`, {
        credentials: "include",
      });
      return { status: response.status, body: await response.json() };
    }, harness.apiOrigin);
    if (!Array.isArray(result.body)) {
      throw new Error(`computer list returned ${JSON.stringify(result)}`);
    }
    return result.body.find(
      (computer: { id: string; status: string }) =>
        computer.id === pairing.paired.computerId,
    )?.status as string | undefined;
  };
  try {
    await expect.poll(computerStatus).toBe("online");
    await openServerSettings(page);
    await expect(
      page.getByRole("heading", { name: "Computers" }),
    ).toBeVisible();
    await expect(
      page.getByTestId(`computer-${pairing.paired.computerId}`),
    ).toContainText("Shared VPSOnline");

    const crossServerProjects = await page.evaluate(
      async ({ computerId, folderPaths, origin }) => {
        const createServer = async (name: string) => {
          const response = await fetch(`${origin}/api/servers`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name }),
          });
          return response.json();
        };
        const first = await createServer("VPS Project Server One");
        const second = await createServer("VPS Project Server Two");
        const createProject = async (serverId: string, folderPath: string) =>
          fetch(`${origin}/api/servers/${serverId}/projects`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              computerId,
              folderPath,
            }),
          });
        return [
          (await createProject(first.id, folderPaths[0])).status,
          (await createProject(second.id, folderPaths[1])).status,
        ];
      },
      {
        computerId: pairing.paired.computerId,
        folderPaths: [firstFolder, secondFolder],
        origin: harness.apiOrigin,
      },
    );
    expect(crossServerProjects).toEqual([201, 201]);

    await stopHost(host);
    await expect.poll(computerStatus).toBe("reconnecting");
    await expect.poll(computerStatus, { timeout: 5_000 }).toBe("offline");

    host = spawn(hostBinary, ["run", "--state", statePath], {
      stdio: "ignore",
    });
    await expect.poll(computerStatus).toBe("online");
    await page.getByRole("button", { name: "Revoke Shared VPS" }).click();
    await expect.poll(computerStatus).toBe("revoked");
  } finally {
    await stopHost(host);
    await rm(directory, { recursive: true, force: true });
  }
});
