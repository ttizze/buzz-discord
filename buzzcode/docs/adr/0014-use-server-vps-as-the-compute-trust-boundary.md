---
status: superseded by ADR-0017
---

# Use each server VPS as a compute trust boundary

Each Buzzcode Host and VPS belongs to exactly one server, while one server may own multiple Hosts and VPSs. Every server project selects exactly one Remote Environment, and its remote agents run normally with that VPS's shell, filesystem, and browser capabilities. Open and private projects organize channels, searchable conversation history, and starting folders, but do not sandbox files or agents from other projects assigned to the same VPS. Private-project agents remain usable and their conversation history stays project-scoped. Assigning projects to separate VPSs provides an infrastructure boundary within one server, while Buzzcode still does not orchestrate per-project sandboxes. This favors understandable Codex-like remote environments and lets administrators separate workloads without creating another collaboration server.
