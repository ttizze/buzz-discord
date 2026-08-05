import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  if (host.exitCode !== null) return;
  host.kill("SIGTERM");
  await new Promise<void>((resolveExit) =>
    host.once("exit", () => resolveExit()),
  );
}

test.beforeAll(async () => {
  await harness.start();
});

test.afterAll(async () => {
  await harness.stop();
});

test("pairs multiple Hosts once while keeping each Host bound to one Server", async ({
  page,
}) => {
  await page.goto(harness.applicationUrl);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await page.getByLabel("Server name").fill("Compute Server");
  await page.getByRole("button", { name: "Create Server" }).click();

  const serverId = await page
    .getByRole("button", { name: "Compute Server" })
    .getAttribute("data-server-id");
  expect(serverId).toBeTruthy();

  const firstCode = await page.evaluate(
    async ({ id, origin }) => {
      const response = await fetch(
        `${origin}/api/servers/${id}/host-pairing-codes`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      const text = await response.text();
      return {
        status: response.status,
        body: text === "" ? {} : JSON.parse(text),
      };
    },
    { id: serverId, origin: harness.apiOrigin },
  );
  expect(firstCode.status).toBe(201);
  expect(firstCode.body.code).toEqual(expect.any(String));
  expect(firstCode.body.expiresAt).toEqual(expect.any(String));

  const firstHost = await page.evaluate(
    async ({ pairingCode, origin }) => {
      const response = await fetch(`${origin}/api/hosts/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pairingCode,
          installationId: "host-one-installation",
          name: "VPS One",
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    { pairingCode: firstCode.body.code, origin: harness.apiOrigin },
  );
  expect(firstHost.status).toBe(201);
  expect(firstHost.body.serverId).toBe(serverId);
  expect(firstHost.body.credential).toEqual(expect.any(String));

  const replayStatus = await page.evaluate(
    async ({ pairingCode, origin }) => {
      return (
        await fetch(`${origin}/api/hosts/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pairingCode,
            installationId: "host-two-installation",
            name: "VPS Two",
          }),
        })
      ).status;
    },
    { pairingCode: firstCode.body.code, origin: harness.apiOrigin },
  );
  expect(replayStatus).toBe(404);

  const secondCode = await page.evaluate(
    async ({ id, origin }) => {
      const response = await fetch(
        `${origin}/api/servers/${id}/host-pairing-codes`,
        { method: "POST", credentials: "include" },
      );
      return (await response.json()).code as string;
    },
    { id: serverId, origin: harness.apiOrigin },
  );
  const secondHost = await page.evaluate(
    async ({ pairingCode, origin }) => {
      const response = await fetch(`${origin}/api/hosts/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pairingCode,
          installationId: "host-two-installation",
          name: "VPS Two",
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    { pairingCode: secondCode, origin: harness.apiOrigin },
  );
  expect(secondHost.status).toBe(201);

  const environments = await page.evaluate(
    async ({ id, origin }) => {
      const response = await fetch(
        `${origin}/api/servers/${id}/remote-environments`,
        { credentials: "include" },
      );
      return { status: response.status, body: await response.json() };
    },
    { id: serverId, origin: harness.apiOrigin },
  );
  expect(environments.status).toBe(200);
  expect(environments.body).toEqual([
    expect.objectContaining({ name: "VPS One", status: "offline" }),
    expect.objectContaining({ name: "VPS Two", status: "offline" }),
  ]);
  await openServerSettings(page);
  await expect(
    page.getByRole("heading", { name: "Remote Environments" }),
  ).toBeVisible();
  await expect(page.getByTestId("remote-environment-list")).toContainText(
    "VPS OneOffline",
  );
  await page.getByRole("button", { name: "Create pairing code" }).click();
  await expect(page.getByTestId("host-pairing-code")).not.toBeEmpty();

  const hostDirectory = await mkdtemp(join(tmpdir(), "buzzcode-host-e2e-"));
  const writeHostState = async (
    fileName: string,
    paired: { id: string; serverId: string; credential: string },
    installationId: string,
    name: string,
  ) => {
    const path = join(hostDirectory, fileName);
    await writeFile(
      path,
      JSON.stringify({
        remoteEnvironmentId: paired.id,
        serverId: paired.serverId,
        apiOrigin: harness.apiOrigin,
        credential: paired.credential,
        installationId,
        name,
      }),
    );
    return path;
  };
  const firstState = await writeHostState(
    "host-one.json",
    firstHost.body,
    "host-one-installation",
    "VPS One",
  );
  const secondState = await writeHostState(
    "host-two.json",
    secondHost.body,
    "host-two-installation",
    "VPS Two",
  );
  let firstProcess: ChildProcess | undefined;
  let secondProcess: ChildProcess | undefined;
  const environmentStatus = async (name: string) => {
    const response = await page.evaluate(
      async ({ id, origin }) => {
        const result = await fetch(
          `${origin}/api/servers/${id}/remote-environments`,
          { credentials: "include" },
        );
        return result.json();
      },
      { id: serverId, origin: harness.apiOrigin },
    );
    return response.find(
      (environment: { name: string; status: string }) =>
        environment.name === name,
    )?.status as string | undefined;
  };
  try {
    firstProcess = spawn(hostBinary, ["run", "--state", firstState], {
      stdio: "ignore",
    });
    secondProcess = spawn(hostBinary, ["run", "--state", secondState], {
      stdio: "ignore",
    });
    await expect.poll(() => environmentStatus("VPS One")).toBe("online");
    await expect.poll(() => environmentStatus("VPS Two")).toBe("online");
    await expect(
      page.getByTestId(`remote-environment-${firstHost.body.id}`),
    ).toContainText("Online");

    await stopHost(firstProcess);
    await expect.poll(() => environmentStatus("VPS One")).toBe("reconnecting");
    await expect
      .poll(() => environmentStatus("VPS One"), { timeout: 5_000 })
      .toBe("offline");
    await expect(
      page.getByTestId(`remote-environment-${firstHost.body.id}`),
    ).toContainText("Offline");
    expect(await environmentStatus("VPS Two")).toBe("online");
    const channelMessageStatus = await page.evaluate(
      async ({ id, origin }) => {
        const channelResponse = await fetch(
          `${origin}/api/servers/${id}/channels`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "host-failure-check" }),
          },
        );
        const channel = await channelResponse.json();
        const messageResponse = await fetch(
          `${origin}/api/servers/${id}/channels/${channel.id}/messages`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: "Server chat remains available" }),
          },
        );
        return messageResponse.status;
      },
      { id: serverId, origin: harness.apiOrigin },
    );
    expect(channelMessageStatus).toBe(201);

    firstProcess = spawn(hostBinary, ["run", "--state", firstState], {
      stdio: "ignore",
    });
    await expect.poll(() => environmentStatus("VPS One")).toBe("online");
    await page.getByRole("button", { name: "Revoke VPS One" }).click();
    await expect.poll(() => environmentStatus("VPS One")).toBe("revoked");
    await expect(
      page.getByTestId(`remote-environment-${firstHost.body.id}`),
    ).toContainText("Revoked");
    expect(await environmentStatus("VPS Two")).toBe("online");
  } finally {
    if (firstProcess !== undefined) await stopHost(firstProcess);
    if (secondProcess !== undefined) await stopHost(secondProcess);
    await rm(hostDirectory, { recursive: true, force: true });
  }

  const otherServer = await page.evaluate(async (origin) => {
    const response = await fetch(`${origin}/api/servers`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Other Server" }),
    });
    return (await response.json()).id as string;
  }, harness.apiOrigin);
  const otherServerCode = await page.evaluate(
    async ({ id, origin }) => {
      const response = await fetch(
        `${origin}/api/servers/${id}/host-pairing-codes`,
        { method: "POST", credentials: "include" },
      );
      return (await response.json()).code as string;
    },
    { id: otherServer, origin: harness.apiOrigin },
  );
  const crossServerStatus = await page.evaluate(
    async ({ pairingCode, origin }) => {
      return (
        await fetch(`${origin}/api/hosts/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pairingCode,
            installationId: "host-one-installation",
            name: "VPS One",
          }),
        })
      ).status;
    },
    { pairingCode: otherServerCode, origin: harness.apiOrigin },
  );
  expect(crossServerStatus).toBe(409);
});
