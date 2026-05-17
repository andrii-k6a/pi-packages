---
name: engineering-discipline
description: Coding philosophy for non-trivial software work. Use when writing, refactoring, or designing code - especially when the request is vague, or the proposed solution feels larger than the problem. Enforces clarifying ambiguity before coding, choosing the simplest solution, keeping diffs surgical, and defining verifiable success checks. Skip for trivial edits, typo fixes, and pure formatting.
license: MIT
---

# Engineering Discipline

A coding philosophy for approaching software work with clarity, restraint, and verification.
Favors thoughtful execution over speed. Use judgment for trivial tasks.

---

## 1. Think Before Coding

**Do not silently resolve ambiguity. Name it, narrow it, or ask.**

Before implementing:
- State your assumptions explicitly.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists than the one requested, say so and push back.
- If the request is unclear, stop. Name what's confusing. Ask.

**Check:** You can state the task in one sentence and list your assumptions as bullets. If you cannot, you are not ready to write code.

---

## 2. Simplicity First

**Use the minimum code that fully solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code — name the second caller that justifies each abstraction. If there is none, inline it.
- No "flexibility" or "configurability" without a concrete, requested need.
- No error handling for impossible or unsupported scenarios.
- If you write 200 lines and it could be 50, rewrite it smaller.

**Check:** Would a senior engineer call this overcomplicated? If yes, simplify. If the solution feels larger than the problem, that feeling is a signal — act on it.

---

## 3. Surgical Changes

**Touch only what the task requires. Clean up only what your change affects.**

When editing existing code:
- Do not refactor unrelated code.
- Do not rewrite adjacent comments, formatting, or structure without a direct reason.
- Match the local style, even if you'd do it differently.
- If you notice unrelated issues or dead code, mention them — don't fix them.

Cleanup boundary: **clean up what your change orphaned; leave what was already dead.**
Remove imports, variables, functions, and tests your change made unused. Do not remove pre-existing dead code unless asked.

**Check:** Re-read the diff. For each changed line, name the requirement it satisfies. If you cannot, revert it.

---

## 4. Verify Outcomes

**Turn the task into checks you can actually run.**

Translate vague requests into concrete success criteria:
- "Add validation" → write tests for invalid inputs, then make them pass.
- "Fix the bug" → reproduce it with a failing test or command, then make the check pass.
- "Refactor X" → pin current behavior with the existing test suite or a new characterization test; verify it still passes after.

For multi-step or non-obvious tasks, state a brief plan before starting:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Prefer checks that tell you when the work is done.

**Check:** Every success criterion is something you can run or observe. Criteria that rely on vague judgment alone ("make it work", "looks good") do not count.
