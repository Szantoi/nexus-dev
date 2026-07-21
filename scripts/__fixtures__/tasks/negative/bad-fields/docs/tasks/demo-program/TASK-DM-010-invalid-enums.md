---
id: TASK-DM-010
title: "Invalid enum/date/missing field demo"
program: NEXUS-DEMO
project: demo/project
milestone: DEMO-M1
epic: DEMO-EPIC
status: in-progress
priority: urgent
depends_on: []
created: 07-18-2026
source: "fixture"
---

Fixture — négy egyidejű mezőhiba: érvénytelen 'status' (in-progress, helyesen
in_progress), érvénytelen 'priority' (urgent), rossz 'created' dátumformátum
(07-18-2026, helyesen YYYY-MM-DD) és hiányzó kötelező 'owner_role' mező.
