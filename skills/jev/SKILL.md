---
name: jev
description: Use TypeSafe’s Jev classifier in Pi codemode when a decision depends on interpreting text, images, or application state. Build, run, or debug workflows that use a yes/no judgment to check a claim against a passage, a label to route an issue, or a score to rank candidates.
---

# Jev in Pi

Use `models.classify()` inside Pi’s `codemode` tool. Start with the action the result will drive.
For a refund queue, Jev can tell whether a customer is asking for their money back. Code can look up
the order, check the date, and apply the refund policy. If parsing or a lookup settles the whole
question, do it in code.

## Before a live call

- If `codemode` is missing, start Pi with `pi --tools +codemode`. The `/model` picker lists chat
  models. Inside `codemode`, use `models.getAvailableOfType("classifier", "typesafe")` to check for
  `jev-latest` without sending a classification request.
- Use the direct `typesafe/jev-latest` route for this workflow. If it is missing, tell the user
  where to configure `TYPESAFE_API_KEY` or the `typesafe` credential in Pi’s `auth.json`. Keep the
  key out of chat. Switching providers requires the user’s agreement.
- A live experiment sends the state, questions, and any images to TypeSafe with the user’s
  credential. Use the agreed data and call or cost limit. If either is unspecified, settle it
  before experimenting. Remove secrets and unnecessary personal data. Pi can display zero cost
  when its catalog lacks a price, even if TypeSafe bills the request.
- For a screenshot, check that the selected model’s `input` includes `"image"`. With direct Jev,
  pass a redacted PNG or JPEG from `tools.read({ path })` in the top-level `images` array.
  Keep the question and any accompanying facts in `questions` and `state`.

## Route Pi package questions

Suppose two help queues cover installing and updating packages. A message can mention installation
in passing. Ask whether either queue applies and which queue fits best in the same request. Each
question sees the message and its own criteria. Code decides whether to use the suggested queue.

This `codemode` script makes two calls on synthetic messages. The cutoffs are starting values for
the example. Choose production thresholds on labeled cases.

```js
const available = await models.getAvailableOfType("classifier", "typesafe");
const jev = available.find(model => model.id === "jev-latest");
if (!jev) return { error: "typesafe/jev-latest unavailable" };

const questions = {
  applies: {
    type: "bool",
    instructions: "Does the author want help installing or updating a Pi package?",
    criteria: {
      true: "The author asks how to install or update a package, or reports that an attempt failed.",
      false: "The author wants help with something else, even if they mention a past installation.",
    },
  },
  queue: {
    type: "choice",
    instructions: "Which package operation does the author want help with?",
    criteria: {
      install: "Adding a package for the first time",
      update: "Getting a newer version of an installed package",
    },
  },
};
const issues = [
  { id: 101, message: "My Pi theme package is one release behind. How do I get the new version?" },
  { id: 102, message: "The theme installed fine. Can I make the sidebar text larger?" },
];

return await Promise.all(issues.map(async ({ id, message }) => {
  const result = await models.classify(jev, { state: { message }, questions });
  if (result.stopReason !== "stop") {
    return { id, status: result.stopReason, error: result.errorMessage || result.stopReason };
  }
  const { applies, queue } = result.answers;
  if (applies.probability < 0.3) return { id, status: "skip" };
  const knownQueue = Object.hasOwn(questions.queue.criteria, queue.choice);
  if (knownQueue && applies.probability > 0.7 && queue.probabilities[queue.choice] > 0.7) {
    return { id, status: "route", queue: queue.choice };
  }
  return { id, status: "review" };
}));
```

The intended outcomes are `update` for issue 101 and `skip` for issue 102. A forced choice still
picks a queue for 102. The applicability check is what keeps it out of both queues.

## Design the state and questions

Could a person answer from the supplied state and question alone? A reply of “yes, that one”
needs the preceding offer and the speakers’ roles. For a claim check, include the claim and cited
passage, and distinguish a contradiction from a passage that says nothing about the claim.

- Use a JSON object with meaningful field names. Resolve opaque IDs, explain project terms, and
  preserve evidence when shortening a thread. An empty `replies` list implies you checked for
  replies. If they were never loaded and the answer depends on them, fetch them or defer the item.
- Ask one observable question in `instructions`, such as “Which attachment does the sender want
  printed?” The question must stand on its own because Jev cannot see its ID. Omit role prompts
  and output-format instructions. For extraction, let code find candidate spans, ask Jev which
  one the sender means, then copy the original value.
- Bundle independent questions about the same item. Put shared facts in `state` and a definition
  used by only one question in its criteria. Start another call when an answer changes the evidence
  to fetch or the options to offer, or when testing shows a shared field distorts another answer.

| Pi type | Write the criteria | Read the answer |
| --- | --- | --- |
| `bool` (TypeSafe’s *Noul*) | Describe concrete situations for both `true` and `false`. “How long do refunds take?” is a useful near miss for a refund request. | `probability` estimates how likely the statement is true. Give the uncertain band an explicit outcome. |
| `choice` | Map distinct, descriptive labels to their meanings. Jev sees the label names. If several can apply and you need them all, ask one `bool` per label. | `choice` is the top label. Inspect `probabilities` for competing labels. `confidence` measures how concentrated the distribution is. |
| `score` | Use an array of levels, lowest first, along one dimension. For disruption, use “task completes normally”, “task requires a workaround”, “task cannot be completed”. | `score` is the expected zero-based level index. Keep fractional values when ranking. Pi also returns `confidence` and omits per-level probabilities. |

For batch work, call once per item and carry its source ID alongside the result. Limit the input
to the remaining budget for `models.classify()` calls before mapping over it. Pi runs up to four
model calls at once per script and queues the rest. A call can retry a provider request.
Return the top matches, counts, errors, or review IDs the task needs.
TypeSafe’s `Box` question is unavailable in Pi’s classifier interface.
For the installed contract, see `docs/codemode.md#classify` and `docs/models.md#use-classifier-models` in
`@earendil-works/pi-coding-agent`.

## Test before scaling up

1. Label a small sample first (roughly 20–30 items for an initial pass). Include ordinary inputs,
   near misses, and cases where nothing fits. Reserve separate cases for the final check.
2. Try competing wordings under different question IDs on the same state. Inspect disagreements.
   Choose thresholds based on what a wrong action costs compared with sending the item to review.
   Keep the questions, criteria, and thresholds together.
3. For a miss, inspect the redacted payload as sent. Look for missing evidence, an absent candidate,
   or two judgments hidden in one question. If two choice labels keep trading places, swap their
   order on the same cases to check for order sensitivity.
4. Replay the reserved cases and check the downstream decisions. Use synthetic or approved,
   redacted examples for regression tests. Exact probabilities and exceptions tailored to one
   failing item make brittle tests.

Keep security and authorization checks in code. Routing by reasoning difficulty, diagnosing which
agent step failed, and grading generated prose are poor defaults for Jev. For fine-grained labels
or low-resource languages, check performance against examples that human reviewers agree on.
For recurring failures, consult the [known model limitations](https://docs.typesafe.ai/go/jaggedness.md).

For more question-design guidance and worked examples of evidence checking and reranking, see the
[official TypeSafe skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md)
and [cookbooks](https://docs.typesafe.ai/go/cookbooks.md).
