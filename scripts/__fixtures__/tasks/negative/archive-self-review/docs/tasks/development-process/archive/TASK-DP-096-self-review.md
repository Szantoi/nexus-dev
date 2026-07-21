---
id: TASK-DP-096
title: "Archived task with a non-independent reviewer demo"
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

# Archived task with a non-independent reviewer demo

## Implementáció (2026-07-18)

Fixture — teljes, egyébként parse-olható `execution_evidence` blokk, DE a
`reviewer.independent` mező `false` (a készítő "ellenőrizte" saját magát) —
a `development-process` program `requireReviewerIndependent` szabálya szerint
ez önmagában megbukik, még ha a `decision: PASS` is (QUALITY.md 8. pont:
"készítő ≠ ellenőr").

```yaml
execution_evidence:
  task_id: TASK-DP-096
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
    identity: "same-agent-as-creator"
    independent: false
    decision: PASS
    evidence: "fixture"
  state_sync:
    task: true
    epics: true
    state: true
    todo: true
    memory: true
```
