---
id: TASK-DM-012
title: "Missing parallel_with reference demo"
program: NEXUS-DEMO
project: demo/project
milestone: DEMO-M1
epic: DEMO-EPIC
status: ready
priority: medium
depends_on: []
parallel_with: [TASK-DM-999]
owner_role: backend
created: 2026-07-18
source: "fixture"
---

Fixture — a `parallel_with` egy nemlétező task-id-re (TASK-DM-999) mutat.
Ez a `depends_on`-tól elkülönített, dedikált eset (a független review
2026-07-18-i, 1. körös megjegyzése szerint korábban csak a kódág
helyességét manuálisan ellenőrizték, dedikált fixture nélkül).
