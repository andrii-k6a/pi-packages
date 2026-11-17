import type { SdlcArgs } from '../workflow/sdlc/contracts.js';
import { validateSdlcArgs } from '../workflow/sdlc/validation.js';

/** The adapter chooses background isolation only when the caller omitted a workspace policy. */
export function prepareSdlcArgs(value: unknown, background = false): SdlcArgs {
  validateSdlcArgs(value);
  return { ...value, workspace: value.workspace ?? { mode: background ? 'isolated' : 'existing' } };
}

export type SdlcCommand =
  | { action: 'start'; args: Record<string, unknown>; background: boolean }
  | { action: 'status'; runId: string }
  | { action: 'cancel'; runId: string }
  | { action: 'answer'; runId: string; questionId: string; briefRevision: number; answer: string }
  | { action: 'continue'; runId: string; options: Record<string, unknown>; background: boolean };

export const SDLC_COMMAND_USAGE =
  '/sdlc [--background] <goal or JSON args> | status <run-id> | cancel <run-id> | answer <run-id> {"questionId":"…","briefRevision":1,"answer":"…"} | [--background] continue <run-id> [JSON options]';

/** Keep goal prose literal. JSON is parsed, never evaluated or split as shell arguments. */
export function parseSdlcCommand(input: string): SdlcCommand {
  let text = input.trim();
  let background = false;
  if (/^--background(?:\s|$)/.test(text)) {
    background = true;
    text = text.slice('--background'.length).trim();
  }
  if (!text) throw new Error(`Usage: ${SDLC_COMMAND_USAGE}`);
  if (/^--(?:\s|$)/.test(text)) {
    const goal = text.slice(2).trim();
    if (!goal) throw new Error('/sdlc requires a non-empty goal');
    return { action: 'start', args: { goal }, background };
  }
  const action = /^(status|cancel|answer|continue)(?:\s|$)/.exec(text)?.[1];
  if (action) {
    const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) throw new Error(`Usage: ${SDLC_COMMAND_USAGE}`);
    const [, , runId, rest] = match;
    if (action === 'status' || action === 'cancel') {
      if (background || rest) throw new Error(`/sdlc ${action} accepts only a run id`);
      return { action, runId };
    }
    if (action === 'continue') {
      return { action, runId, options: rest ? jsonObject(rest) : {}, background };
    }
    if (background) throw new Error('/sdlc answer records an answer only. Continue separately.');
    const answer = jsonObject(rest ?? '');
    if (
      Object.keys(answer).some((key) => !['questionId', 'briefRevision', 'answer'].includes(key)) ||
      typeof answer.questionId !== 'string' ||
      !answer.questionId.trim() ||
      !Number.isSafeInteger(answer.briefRevision) ||
      (answer.briefRevision as number) < 1 ||
      typeof answer.answer !== 'string' ||
      !answer.answer.trim()
    ) {
      throw new Error(
        '/sdlc answer requires questionId, a positive briefRevision, and a non-empty answer string'
      );
    }
    return {
      action: 'answer',
      runId,
      questionId: answer.questionId,
      briefRevision: answer.briefRevision as number,
      answer: answer.answer
    };
  }
  if (text.startsWith('-')) throw new Error(`Unknown /sdlc option. Usage: ${SDLC_COMMAND_USAGE}`);
  return {
    action: 'start',
    args: text.startsWith('{') ? jsonObject(text) : { goal: text },
    background
  };
}

function jsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('/sdlc requires a valid JSON object. Do not shell-quote or fence the JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('/sdlc requires a JSON object');
  }
  return value as Record<string, unknown>;
}
