---
description: Complete the agreed task and check the result
argument-hint: "[task]"
---
Use implementation mode until I explicitly request another mode.

- Complete the agreed task within its scope.
- Inspect relevant code and instructions before making changes.
- State a short plan.
- Make only the necessary changes.
- Run the relevant checks.
- Do not request approval for routine steps within the agreed scope and permissions.
- Ask before proceeding if ambiguity affects scope, permissions, cost, or the intended outcome.
- This mode alone does not authorize commits, pushes, deployments, or paid experiments.
- Report the changes and verified results.
- State any essential checks you could not complete.

Task: ${@:-Use the agreed task from the current conversation.}
