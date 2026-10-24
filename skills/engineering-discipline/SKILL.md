---
name: engineering-discipline
description: Rules for planning, changing, checking, testing, and documenting software. Use when designing, writing, refactoring, or reviewing code, tests, comments, or developer documentation, and when fixing bugs or checking that a change works. Skip for trivial work.
license: MIT
---

# Engineering Discipline

Rules for planning, changing, checking, testing, and documenting software.

---

## 1. Plan Before Implementing

**Have a short, clear plan before you implement. Resolve ambiguity first, or ask.**

- Start the plan with the goal, followed by a roadmap. The goal is the problem to solve or the intent behind the request, in a few sentences. The roadmap is the steps to reach it.
- Include assumptions, choices and the reasons for them, and resolved ambiguities when they exist. Explain tradeoffs between real alternatives.
- Keep the plan as short as the task allows.
- If the request has more than one valid interpretation, name them. Do not pick one silently. If no clear answer exists, ask.
- Read the relevant code before you ask. Include third-party libraries and frameworks. Ask only what the code cannot answer.
- Trust code over comments and documentation. They can be outdated, wrong, or misleading.
- Use the plan as your reference while you implement. After each iteration, compare the work with it. If something is off, stop and state the problem. Do not change direction silently.

**Check:** Do you have a plan with the goal and a roadmap to reach it? Does the current work still match it?

---

## 2. Simplicity First

**Use the least code that solves the problem. Do not add code for needs that do not exist yet.**

- Add only the requested behavior. Do not add abstractions, settings, or options for possible future needs.
- Add an abstraction only when you can name a second caller that needs it. Otherwise keep the code inline.
- Suggest a simpler approach if it meets the same requirements.
- Handle errors that can realistically occur, especially at system boundaries such as user input, files, network calls, and external services. Report them with a clear message or pass them to a caller that can handle them. Do not hide errors.
- Make the code readable for someone with little context. Use clear names and structure so the code explains itself.
- Leave out detail the reader does not need, such as extra logging, helpers, and handling for cases the task does not involve.
- Keep the size of the change in proportion to the problem. If a large change solves a small problem, stop and look for a smaller one.

**Check:** Can you remove any code without losing required behavior or clarity? Is the size of the change in proportion to the problem?

---

## 3. Surgical Changes

**Change only what the task needs. Clean up only what your change affects.**

- Do not change unrelated code, comments, or formatting. Small diffs make review and bug tracing easier.
- Match the local style, even if you would do it differently.
- Mention unrelated problems when useful. Do not fix them as part of this task.
- Update or remove code, tests, comments, and documentation that your change makes unused or incorrect.

**Check:** Review the diff. Does every change serve the task? Does it include unrelated edits or formatting changes? Did your change leave anything unused or incorrect?

---

## 4. Check the Result

**Check that the change solves the problem. Report what the checks show.**

- Verify against the goal. If you do not have one, state it first.
- Before you edit, decide which one or few checks will show that the goal is reached. Each check must be something you can run or observe.
- Check the real behavior when you can. If that is hard to do yourself, ask the user for help before you build a workaround. For example, ask the user to sign in or to enable a browser tool, instead of mocking authentication or writing scripts that only simulate a browser.
- For a bug fix, reproduce the bug first. Confirm it fails for the reported reason, not because of a setup error.
- For a refactor, make sure the existing checks cover the behavior you change, and run them before and after. If they do not, add a check for that behavior first.
- Report the one or few checks that show the goal is reached, and their results. Do not list every check you ran. Say what you could not check only if it is essential to the goal.

**Check:** Do you have the goal? Can you name the check that shows it is reached? Did you report any essential check that you could not complete?

---

## 5. Test for Meaningful Regressions

**Write tests that fail when important behavior breaks. Do not add tests that protect nothing.**

- Test the behavior that matters: requirements, results the user can see, and fixed bugs. Do not test for coverage or implementation details.
- Extend existing tests when possible. Add a case only for a risk that no existing test covers.
- Take expected results from requirements, not from the current output of the code, unless you are preserving behavior in a refactor.
- Test through real entry points. Use integration tests for bugs between components.
- Assert the specific result, side effect, or error that matters. Prefer specific assertions over snapshots. Assert calls between components only when they are required behavior.
- Mock only external dependencies, and only when needed. Never mock the behavior the test checks.
- Keep automated tests repeatable: control time and random values, wait for conditions instead of fixed delays, and avoid live services and credentials.
- Never weaken assertions, skip failing tests, or relax test settings just to pass.
- Run the smallest relevant set of tests first, then widen to affected integrations and the checks the repository requires. Disable watch mode.

**Check:** Can you state which behavior each test protects? Could it still pass while that behavior is broken? Is any important behavior left untested?

---

## 6. Comment Only When Needed

**Every comment has a maintenance cost. Add one only when the code cannot make the point clear.**

- Add a comment only for what names and structure cannot show: why the code is written this way, a constraint, or required behavior that types cannot express.
- Do not repeat what the code, types, or existing documentation already say.
- Make each comment self-contained. Do not refer to tickets, specs, or task files, because they can be temporary or hard to keep consistent. State the fact itself. Refer to an external source only when it is stable and needed, such as a standard or an upstream bug behind a workaround.
- State only what you know from the requirements or the user. If you do not know the reason, ask or leave the comment out. Do not invent history, business rules, or guarantees.
- Follow project conventions or patterns for existing comments.

**Check:** What would the reader lose without this comment? Does it say something the code and existing documentation do not? Does it make sense without any link or file?

---

## 7. Keep Documentation Useful

**Add documentation only when a reader needs it. Keep it concise, free of duplication, and easy to follow for a reader with minimal context.**

- Before you add documentation, state what the reader will understand or be able to do with it. If you cannot, do not add it.
- Update existing documentation before you add a new document. State each fact once and link to it from elsewhere, even if the repeat uses different words. If you find duplication in the documentation you are changing, fix it.
- Start with a high-level explanation of what the topic is and why it exists. Add context next, and put low-level details last.
- Use plain formatting. Avoid semicolons and dashes as punctuation, and avoid nested lists. Diagrams are fine.
- Keep documentation used only by agents, such as task context and specs, short and accurate.
- Keep `README.md` to purpose, setup, usage, and development. Put design details and progress where the project already keeps them.
- Describe current behavior and limitations, except in intentional migration instructions and records of past decisions. Check commands, paths, and examples against the project.
- Do not depend on temporary material such as task files for agents, tickets, or progress notes. Document the facts themselves.

**Check:** Does it tell the reader something they need to understand or do? Is each fact in one place only? Can the reader follow it from the main idea to the details without text they do not need? Are commands, paths, and examples correct?
