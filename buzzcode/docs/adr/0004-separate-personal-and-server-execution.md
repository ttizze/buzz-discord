---
status: superseded by ADR-0017
---

# Separate personal and server execution environments

Personal projects and agent direct messages use the user's local computer and local agents, while server projects use shared remote environments and remote agents. A server project never connects to a member's local computer. This strict boundary gives server members a common execution target and prevents server access from becoming an implicit path into personal machines, at the cost of requiring remote infrastructure for every server project.
