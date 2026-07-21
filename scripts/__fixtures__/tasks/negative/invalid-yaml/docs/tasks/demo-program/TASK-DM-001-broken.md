---
id: TASK-DM-001
title: Broken frontmatter demo
program: NEXUS-DEMO
project: demo/project
milestone: DEMO-M1
epic: DEMO-EPIC
status: ready
priority: medium
depends_on: []
owner_role: backend
created: 2026-07-18
source: TASK-DM-001 B.3 (allowlist: .file-size-allowlist.json, expires 2026-10-18)
---

# Broken frontmatter demo

Ugyanaz a hibaosztály, mint a valós TASK-QC-008A…E frontmatterben: az
idézőjel nélküli `source:` érték tartalmaz egy beágyazott `kulcs: érték`
mintát ("allowlist: .file-size-allowlist.json"), ami a YAML-parser számára
kettőspont-kétértelműséget okoz és érvénytelen frontmattert eredményez.
