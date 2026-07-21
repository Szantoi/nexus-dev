---
id: TASK-DP-097
title: "Archived task with non-done status demo"
program: NEXUS-DEMO
project: demo/project
milestone: DEMO-M1
epic: DEMO-EPIC
status: ready
priority: medium
depends_on: []
owner_role: backend
created: 2026-07-18
source: "fixture"
---

# Archived task with non-done status demo

## Implementáció (2026-07-18)

Fixture — a fájl az `archive/` alatt van, de a frontmatter `status: ready`
(nem `done`) — ez önmagában megbukik, függetlenül az evidence-blokktól.

```yaml
execution_evidence:
  task_id: TASK-DP-097
  goal: "Fixture."
  success_criteria: ["Fixture."]
  exit_condition: "Fixture."
  base_commit: "0000000"
  branch: "fixture"
  commits: ["0000000"]
  pull_request: "N/A"
  environments:
    - os: linux
      shell: bash
      node: "24.13.0"
  commands:
    - command: "echo fixture"
      exit_code: 0
      result: PASS
  reviewer:
    identity: "fixture-reviewer"
    independent: true
    decision: PASS
    evidence: "fixture"
  state_sync:
    task: true
    epics: true
    state: true
    todo: true
    memory: true
```
