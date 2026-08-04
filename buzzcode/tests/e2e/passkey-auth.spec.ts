import { type APIRequestContext, expect, test } from "@playwright/test";
import { E2eHarness } from "./harness";

const harness = new E2eHarness();

test.beforeAll(async () => {
  await harness.start();
});

test.afterAll(async () => {
  await harness.stop();
});

async function completeOidcFlow(
  request: APIRequestContext,
  tokenMode = "valid",
) {
  await request.get(
    `${harness.identityProviderOrigin}/test/next-token?mode=${tokenMode}`,
  );
  const login = await request.get(`${harness.apiOrigin}/api/auth/login`, {
    maxRedirects: 0,
  });
  const authorizationUrl = new URL(login.headers().location);
  const complete = await request.post(
    `${harness.identityProviderOrigin}/complete`,
    {
      form: {
        redirect_uri: authorizationUrl.searchParams.get("redirect_uri") ?? "",
        state: authorizationUrl.searchParams.get("state") ?? "",
        nonce: authorizationUrl.searchParams.get("nonce") ?? "",
        code_challenge:
          authorizationUrl.searchParams.get("code_challenge") ?? "",
      },
      maxRedirects: 0,
    },
  );
  const callbackUrl = complete.headers().location;
  return {
    callbackUrl,
    response: await request.get(callbackUrl, { maxRedirects: 0 }),
  };
}

test("rejects unauthenticated access to protected application data", async ({
  request,
}) => {
  const response = await request.get(`${harness.apiOrigin}/api/bootstrap`);
  expect(response.status()).toBe(401);
});

for (const tokenMode of ["expired", "invalid-signature", "missing-email"]) {
  test(`rejects a ${tokenMode} identity assertion`, async ({ request }) => {
    const { response } = await completeOidcFlow(request, tokenMode);
    expect(response.status()).toBe(400);
  });
}

test("rejects a replayed OIDC callback and a callback without assertions", async ({
  request,
}) => {
  const { callbackUrl, response } = await completeOidcFlow(request);
  expect(response.status()).toBe(303);
  expect((await request.get(callbackUrl, { maxRedirects: 0 })).status()).toBe(
    400,
  );
  expect(
    (
      await request.get(`${harness.apiOrigin}/api/auth/callback`, {
        maxRedirects: 0,
      })
    ).status(),
  ).toBe(400);
});

test("signs in through Rauthy with a passkey and restores the session", async ({
  page,
}) => {
  await page.goto(harness.applicationUrl);
  await expect(
    page.getByRole("heading", { name: "Sign in to Buzzcode" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(
    page.getByRole("heading", { name: "Rauthy test boundary" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue with passkey" }).click();

  await expect(page.getByTestId("signed-in-user")).toHaveText(
    "owner@example.com",
  );
  await page.reload();
  await expect(page.getByTestId("signed-in-user")).toHaveText(
    "owner@example.com",
  );
});
