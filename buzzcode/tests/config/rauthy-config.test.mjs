import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("Rauthy deployment is pinned and exposes only the approved client flow", async () => {
  const compose = await readFile(
    resolve(root, "deploy/rauthy/docker-compose.yml"),
    "utf8",
  );
  const clients = JSON.parse(
    await readFile(
      resolve(root, "deploy/rauthy/bootstrap/clients.json"),
      "utf8",
    ),
  );

  assert.match(compose, /image: ghcr\.io\/sebadob\/rauthy:0\.36\.1/);
  assert.match(compose, /ENABLE_DYN_CLIENT_REG: "false"/);
  assert.match(compose, /ENABLE_EPHEMERAL_CLIENTS: "false"/);
  assert.match(compose, /OPEN_USER_REG: "false"/);
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0].flows_enabled, ["authorization_code"]);
  assert.deepEqual(clients[0].challenges, ["S256"]);
  assert.equal(clients[0].force_mfa, true);
  assert.equal(clients[0].secret, "generate");
});
