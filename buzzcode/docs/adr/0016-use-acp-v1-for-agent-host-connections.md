# Use ACP v1 for Agent Host connections

Buzzcode will use stable Agent Client Protocol v1 for agent lifecycle and messages rather than define a proprietary agent protocol. The SaaS-to-Host link carries ACP JSON-RPC over an authenticated outbound WebSocket custom transport, and the Host bridges to local Codex or Claude Code processes over ACP's standard stdio transport. Host pairing and transport authentication remain outside the agent protocol. ACP v2 and Streamable HTTP are drafts and will not be used in v1.
