# Buzz Host on a headless VPS

`buzz-host` turns a Linux server into a Buzz computer without installing or
opening Buzz Desktop on that server. Initial configuration happens over SSH:
the host prints a one-time pairing URI, and the owner pastes it into Buzz
Desktop on their own computer.

The VPS keeps its own Nostr key. The owner's private key never leaves Desktop;
pairing returns only an encrypted owner attestation. Folder paths and listings
are also NIP-44 encrypted between the owner and the paired host.

## Install

Build the Host and ACP harness from this repository, then install the binaries:

```bash
. ./bin/activate-hermit
cargo build --release -p buzz-host -p buzz-acp -p buzz-dev-mcp
sudo install -m 0755 target/release/buzz-host /usr/local/bin/buzz-host
sudo install -m 0755 target/release/buzz-acp /usr/local/bin/buzz-acp
sudo install -m 0755 target/release/buzz-dev-mcp /usr/local/bin/buzz-dev-mcp
```

For a Codex-backed Host, install the headless ACP adapter too:

```bash
sudo npm install -g @agentclientprotocol/codex-acp
```

Create a dedicated Unix account. Its normal filesystem permissions define what
community-launched agents can read or change, so give it access to every folder
you intend to expose as a project and do not run it as root.

```bash
sudo useradd --system --create-home --home-dir /var/lib/buzz-host --shell /usr/sbin/nologin buzz
sudo install -d -m 0700 -o buzz -g buzz /var/lib/buzz-host
```

## Pair over SSH

Run this interactively as the service account. `--default-path` is where the
remote folder browser starts; it is not a security boundary.

```bash
sudo -u buzz /usr/local/bin/buzz-host \
  --state-dir /var/lib/buzz-host \
  pair \
  --relay wss://buzz.example.com \
  --default-path /srv/projects
```

Then, on the owner's normal computer:

1. Open Buzz Desktop → Settings → Computers → Add computer.
2. Paste the `nostrpair://…` URI printed in SSH.
3. Confirm that the six-digit code shown in both places matches.
4. Type `yes` in SSH.

No VNC, virtual display, or web admin panel is required. The pairing URI is
single-session secret material; do not paste it into chat or logs.

## Run with systemd

Install the unit and a root-readable provider environment file:

```bash
sudo install -D -m 0644 deploy/buzz-host/buzz-host.service \
  /etc/systemd/system/buzz-host.service
sudo install -D -m 0600 deploy/buzz-host/environment.example \
  /etc/buzz-host/environment
sudoedit /etc/buzz-host/environment
sudo systemctl daemon-reload
sudo systemctl enable --now buzz-host
```

Check the non-secret state and logs:

```bash
sudo -u buzz buzz-host --state-dir /var/lib/buzz-host status
sudo journalctl -u buzz-host -f
```

When the service publishes online presence, the paired VPS appears in the
Computer selector in Create project. Selecting it opens the encrypted remote
folder browser. Agent tasks for that project are routed only to the ACP harness
whose stable computer ID matches the selected host.

## Run without an AI agent

For pairing and remote folder browsing only:

```bash
sudo -u buzz buzz-host --state-dir /var/lib/buzz-host run --no-agent
```

This mode deliberately stays offline in the Create project selector because it
cannot execute project tasks.
