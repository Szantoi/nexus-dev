---
id: TASK-DM-013
title: "Task program diverges from its own epic's program demo"
program: NEXUS-OTHER-DEMO
project: demo/project
milestone: OTHER-M1
epic: DEMO-EPIC
status: ready
priority: medium
depends_on: []
owner_role: backend
created: 2026-07-18
source: "fixture"
---

# Task program diverges from its own epic's program demo

Fixture — a task-id (`TASK-DM-013`) és a fájlútvonal helyesen szerepel a
`DEMO-EPIC` epic `tasks[]` listájában (a `checkEpicsMembership` és az `epic`
membership-egyeztetés is zöld lenne önmagában), DE a frontmatter `program:
NEXUS-OTHER-DEMO`, miközben a `DEMO-EPIC` az EPICS.yaml-ban ténylegesen
`program: NEXUS-DEMO` alá tartozik. A `milestone: OTHER-M1` is a
`NEXUS-OTHER-DEMO` program saját, valós mérföldköve — tehát az egyedi
`program`/`milestone` létezés-ellenőrzések önmagukban ZÖLDEK lennének,
csak az epic-hez viszonyított program-egyezés hiányzik. Ezt a
`checkEpicsReferences` `program`-ágának bővítése kapja el (a 2. körös
független review 2026-07-18-i, 3. talált gapje nyomán — a `milestone`-ra
NINCS hasonló ellenőrzés, mert az szándékosan, dokumentáltan lazább,
ld. QC-VERIFICATION precedens).
