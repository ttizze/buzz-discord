---
status: superseded by ADR-0017
---

# Isolate server-project agent runs with Git worktrees

Every server project must point to a Git repository. Each Agent Run uses Codex-compatible Git and worktree behavior, allowing runs from different channels or agents to execute in parallel without overwriting one another's files. Buzzcode will not invent a separate apply, merge, or branch-lifecycle workflow; those interactions follow the selected agent's familiar behavior. Personal projects remain usable with non-Git folders.
