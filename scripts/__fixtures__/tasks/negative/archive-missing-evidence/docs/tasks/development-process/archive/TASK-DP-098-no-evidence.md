---
id: TASK-DP-098
title: "Archived task without execution_evidence demo"
program: NEXUS-DEMO
project: demo/project
milestone: DEMO-M1
epic: DEMO-EPIC
status: done
priority: medium
depends_on: []
owner_role: backend
created: 2026-07-18
source: "fixture"
---

# Archived task without execution_evidence demo

## Implementáció (2026-07-18)

Fixture — az archívum-szakasz megvan, de a `development-process` program
archívum-szabálya (task-schema.json archivePolicy.perProgram) szerint
kötelező `execution_evidence:` YAML-blokk HIÁNYZIK. Ez a legveszélyesebb
archívum-hiba: bizonyíték nélküli "done" jelölés.
