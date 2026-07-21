---
id: TASK-DP-099
title: "Demo archivált task"
program: NEXUS-DEMO
project: demo/project
milestone: DEMO-M1
epic: DEMO-EPIC
status: done
priority: high
depends_on: []
parallel_with: []
owner_role: tooling
created: 2026-07-18
source: "fixture"
---

# Demo archivált task

## Implementáció (2026-07-18)

Fixture — pozitív eset, archivált task, teljes evidence manifesttel és
független, PASS reviewerrel.

```yaml
execution_evidence:
  task_id: TASK-DP-099
  goal: "Fixture goal."
  success_criteria: ["Fixture criterion."]
  exit_condition: "Fixture exit condition."
  base_commit: "0000000"
  branch: "fixture-branch"
  commits: ["0000000"]
  pull_request: "N/A — fixture"
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
