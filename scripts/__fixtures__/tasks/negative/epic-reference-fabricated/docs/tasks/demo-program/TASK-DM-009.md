---
id: TASK-DM-009
title: "Task with fabricated program/milestone/epic references demo"
program: NEXUS-COMPLETELY-FAKE-PROGRAM-XYZ
project: demo/project
milestone: FAKE-MILESTONE-XYZ
epic: EPIC-TOTALLY-DIFFERENT-AND-NONEXISTENT
status: ready
priority: medium
depends_on: []
owner_role: backend
created: 2026-07-18
source: "fixture"
---

# Task with fabricated program/milestone/epic references demo

Fixture — a task-id (`TASK-DM-009`) és a fájlútvonal helyesen szerepel az
EPICS.yaml `DEMO-EPIC` epicjének `tasks[]` listájában (a `checkEpicsMembership`
bidirekcionális tagság-ellenőrzése ezért ZÖLD lenne önmagában), DE a
frontmatter `program`/`milestone`/`epic` mezői teljesen kitalált, az
EPICS.yaml-ban NEM létező értékek. Ezt a `checkEpicsReferences` fogja
elkapni (a TASK-DP-003 független reviewjának 1. talált rése, 2026-07-18).
