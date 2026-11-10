// Offline upstream classifier probe. No model or network calls.
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';

const cases = [
  { errorMessage: '429 {"error":{"type":"budget_exceeded"}}', expected: false },
  { errorMessage: '400 {"error":{"type":"budget_exceeded"}}', expected: false },
  { errorMessage: '429 rate limit exceeded', expected: true }
];

for (const { errorMessage, expected } of cases) {
  const actual = isRetryableAssistantError({ stopReason: 'error', errorMessage });
  console.log(JSON.stringify({ errorMessage, expected, actual, matches: actual === expected }));
}
