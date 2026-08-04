# Rauthy deployment baseline

Buzzcode pins Rauthy `v0.36.1`. Generate a production `config.toml` with that image, then set the effective public URL, proxy trust, SMTP credentials, encryption keys, backups, and these values:

```toml
[bootstrap]
bootstrap_dir = "/app/bootstrap"
generated_secrets_ttl = 600

[server]
scheme = "http"
proxy_mode = true
pub_url = "auth.example.com"

[webauthn]
rp_id = "auth.example.com"
rp_origin = "https://auth.example.com:443"
rp_name = "Buzzcode"

[dynamic_clients]
enable = false

[ephemeral_clients]
enable = false

[user_registration]
enable = false
```

Before first start, replace the example callback and client URI in `bootstrap/clients.json`. The client permits only Authorization Code with S256 PKCE; it has no refresh-token, password, dynamic-client, or ephemeral-client grant. Rauthy generates its client secret into the encrypted bootstrap secret container.

Start Rauthy with absolute, access-controlled paths:

```bash
RAUTHY_CONFIG_PATH=/srv/buzzcode/rauthy/config.toml \
RAUTHY_DATA_PATH=/srv/buzzcode/rauthy/data \
docker compose -f deploy/rauthy/docker-compose.yml up -d
```

Extract the client secret within ten minutes and purge the container:

```bash
docker compose -f deploy/rauthy/docker-compose.yml exec rauthy \
  rauthy bootstrap get -c /app/config.toml --kind client \
  --id buzzcode-desktop --field secret --format raw
docker compose -f deploy/rauthy/docker-compose.yml exec rauthy \
  rauthy bootstrap purge -c /app/config.toml
```

Create users in the Rauthy administration UI. Their activation email lets them choose a Passkey-only account; do not set a password. Losing every Passkey requires an administrator to reset the user's MFA devices.

Use Resend's SMTP endpoint for email delivery. Keep SMTP credentials and Rauthy encryption keys outside this repository, back up `/app/data`, and test restore and urgent version-patch procedures before public beta.

For the packaged macOS app, configure both `BUZZCODE_APP_URL` and `BUZZCODE_APP_ORIGIN` as `tauri://localhost`; development uses `http://localhost:1420`. Production session cookies are `HttpOnly`, `Secure`, and `SameSite=None`, while Buzzcode rejects protected requests and WebSocket upgrades from any other Origin.
