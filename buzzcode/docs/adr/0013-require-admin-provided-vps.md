---
status: superseded by ADR-0017
---

# Require server-admin-provided VPS infrastructure

Buzzcode v1 will not provision or resell compute for server projects. A Server Owner or Admin may supply multiple VPSs, install one `buzzcode-host` service on each, pair every Buzzcode Host with exactly one server using a one-time code, and configure the folders and remote agents available on each VPS. A server may accept multiple Hosts, and each Host may serve multiple projects in that server but never another server. VPS and model-provider costs remain with the server operator, avoiding compute billing and abuse-management scope in the initial SaaS release.
