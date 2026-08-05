import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate an E2E port");
  }
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  return address.port;
}

async function waitFor(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child process has not bound its port yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function run(command: string, args: string[], environment = process.env) {
  const child = spawn(command, args, {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
  const exitCode = await new Promise<number | null>((resolveExit) =>
    child.on("exit", resolveExit),
  );
  if (exitCode !== 0) {
    throw new Error(`${command} failed:\n${Buffer.concat(output).toString()}`);
  }
}

export class E2eHarness {
  private server: ChildProcess | undefined;
  private preview: ChildProcess | undefined;
  private identityProvider: ChildProcess | undefined;
  private directory: string | undefined;
  private databaseStarted = false;
  private databasePort = 0;
  private serverPort = 0;
  private previewPort = 0;
  private identityProviderPort = 0;

  get applicationUrl(): string {
    return `http://127.0.0.1:${this.previewPort}/?apiOrigin=${encodeURIComponent(this.apiOrigin)}`;
  }

  get apiOrigin(): string {
    return `http://127.0.0.1:${this.serverPort}`;
  }

  get identityProviderOrigin(): string {
    return `http://127.0.0.1:${this.identityProviderPort}`;
  }

  async start(): Promise<void> {
    this.directory = await mkdtemp(join(tmpdir(), "buzzcode-e2e-"));
    const ports = new Set<number>();
    while (ports.size < 4) ports.add(await availablePort());
    [
      this.databasePort,
      this.serverPort,
      this.previewPort,
      this.identityProviderPort,
    ] = ports;
    const dataDirectory = join(this.directory, "postgres");
    await run("initdb", [
      "-A",
      "trust",
      "--no-locale",
      "-E",
      "UTF8",
      "-D",
      dataDirectory,
    ]);
    await run("pg_ctl", [
      "-D",
      dataDirectory,
      "-l",
      join(this.directory, "postgres.log"),
      "-o",
      `-F -p ${this.databasePort} -k /tmp`,
      "-w",
      "start",
    ]);
    this.databaseStarted = true;
    await run("createdb", [
      "-h",
      "127.0.0.1",
      "-p",
      String(this.databasePort),
      "buzzcode",
    ]);
    await this.startPreview();
    await this.startIdentityProvider();
    await this.startServer();
  }

  async restartServer(): Promise<void> {
    await this.stopServer();
    await this.startServer();
  }

  async stop(): Promise<void> {
    await this.stopChild("preview");
    await this.stopServer();
    await this.stopChild("identityProvider");
    if (this.directory !== undefined) {
      const dataDirectory = join(this.directory, "postgres");
      if (this.databaseStarted) {
        await run("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"]);
        this.databaseStarted = false;
      }
      await rm(this.directory, { recursive: true, force: true });
    }
  }

  private async startServer(): Promise<void> {
    const databaseUrl = `postgresql://localhost:${this.databasePort}/buzzcode`;
    const apiOrigin = `http://127.0.0.1:${this.serverPort}`;
    this.server = spawn(resolve(root, "target/debug/buzzcode-server"), [], {
      cwd: root,
      env: {
        ...process.env,
        BUZZCODE_BIND: `127.0.0.1:${this.serverPort}`,
        DATABASE_URL: databaseUrl,
        BUZZCODE_APP_URL: this.applicationUrl,
        BUZZCODE_APP_ORIGIN: `http://127.0.0.1:${this.previewPort}`,
        BUZZCODE_OIDC_CLIENT_ID: "buzzcode-desktop",
        BUZZCODE_OIDC_CLIENT_SECRET: "e2e-client-secret",
        BUZZCODE_OIDC_ISSUER: `http://127.0.0.1:${this.identityProviderPort}`,
        BUZZCODE_OIDC_REDIRECT_URI: `${apiOrigin}/api/auth/callback`,
        BUZZCODE_SESSION_COOKIE_SECURE: "false",
        BUZZCODE_HOST_RECONNECT_GRACE_MS: "1000",
        RUST_LOG: "buzzcode_server=info",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitFor(`http://127.0.0.1:${this.serverPort}/health/ready`);
  }

  private async startIdentityProvider(): Promise<void> {
    this.identityProvider = spawn(
      "node",
      [resolve(root, "tests/e2e/fake-oidc-provider.mjs")],
      {
        cwd: root,
        env: {
          ...process.env,
          FAKE_OIDC_CLIENT_ID: "buzzcode-desktop",
          FAKE_OIDC_PORT: String(this.identityProviderPort),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await waitFor(
      `http://127.0.0.1:${this.identityProviderPort}/.well-known/openid-configuration`,
    );
  }

  private async stopServer(): Promise<void> {
    await this.stopChild("server");
  }

  private async startPreview(): Promise<void> {
    this.preview = spawn(
      "pnpm",
      [
        "--dir",
        "desktop",
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        String(this.previewPort),
      ],
      { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitFor(`http://127.0.0.1:${this.previewPort}`);
  }

  private async stopChild(
    field: "identityProvider" | "preview" | "server",
  ): Promise<void> {
    const child = this[field];
    this[field] = undefined;
    if (child === undefined || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) =>
      child.once("exit", () => resolveExit()),
    );
  }

  async diagnostics(): Promise<string> {
    if (this.directory === undefined) return "harness was not started";
    return readFile(join(this.directory, "postgres.log"), "utf8");
  }
}
