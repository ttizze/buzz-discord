import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";

const port = Number.parseInt(process.env.FAKE_OIDC_PORT ?? "", 10);
if (!Number.isInteger(port)) throw new Error("FAKE_OIDC_PORT is required");

const issuer = `http://127.0.0.1:${port}`;
const clientId = process.env.FAKE_OIDC_CLIENT_ID ?? "buzzcode-desktop";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = publicKey.export({ format: "jwk" });
const keyId = "buzzcode-e2e";
const codes = new Map();
let nextTokenMode = "valid";

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function idToken(nonce, mode) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", kid: keyId }));
  const claims = {
    iss: issuer,
    sub: "rauthy-user-1",
    aud: clientId,
    exp: mode === "expired" ? now - 60 : now + 300,
    iat: now,
    nonce,
    email: "owner@example.com",
    email_verified: true,
    preferred_username: "owner",
  };
  if (mode === "missing-email") delete claims.email;
  const payload = base64Url(JSON.stringify(claims));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
  }).toString("base64url");
  return `${header}.${payload}.${mode === "invalid-signature" ? "invalid" : signature}`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", issuer);
  if (url.pathname === "/.well-known/openid-configuration") {
    json(response, 200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "profile", "email"],
      claims_supported: [
        "sub",
        "aud",
        "exp",
        "iat",
        "iss",
        "nonce",
        "email",
        "email_verified",
        "preferred_username",
      ],
    });
    return;
  }
  if (url.pathname === "/jwks") {
    json(response, 200, {
      keys: [{ ...jwk, alg: "RS256", kid: keyId, use: "sig" }],
    });
    return;
  }
  if (url.pathname === "/test/next-token") {
    nextTokenMode = url.searchParams.get("mode") ?? "valid";
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === "/authorize") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body>
      <h1>Rauthy test boundary</h1>
      <p>owner@example.com</p>
      <form method="post" action="/complete">
        ${["redirect_uri", "state", "nonce", "code_challenge"].map((key) => `<input type="hidden" name="${key}" value="${url.searchParams.get(key) ?? ""}">`).join("")}
        <button type="submit">Continue with passkey</button>
      </form>
    </body></html>`);
    return;
  }
  if (url.pathname === "/complete" && request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const code = randomUUID();
    codes.set(code, {
      challenge: form.get("code_challenge"),
      mode: nextTokenMode,
      nonce: form.get("nonce"),
      redirectUri: form.get("redirect_uri"),
    });
    nextTokenMode = "valid";
    const callback = new URL(form.get("redirect_uri"));
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", form.get("state"));
    response.writeHead(303, { location: callback.toString() });
    response.end();
    return;
  }
  if (url.pathname === "/token" && request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const code = codes.get(form.get("code"));
    codes.delete(form.get("code"));
    const challenge = createHash("sha256")
      .update(form.get("code_verifier") ?? "")
      .digest("base64url");
    if (
      code === undefined ||
      challenge !== code.challenge ||
      form.get("redirect_uri") !== code.redirectUri
    ) {
      json(response, 400, { error: "invalid_grant" });
      return;
    }
    json(response, 200, {
      access_token: "fake-access-token",
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken(code.nonce, code.mode),
      scope: "openid profile email",
    });
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(port, "127.0.0.1");
