# Buzz Discord agent runtime (Nix)

This flake pins the Node.js runtime and Claude ACP adapter used by the VPS
`buzz-discord-agent.service`. Buzz relay services remain in the production
Docker Compose stack; the agent harness launches the immutable Nix output.

```bash
nix build .#claude-agent-acp
./result/bin/claude-agent-acp --version
```

The Anthropic API key and Nostr agent key are runtime secrets and must stay in
the root-owned `/etc/buzz-discord/agent.env`; they are never placed in the Nix
store.
