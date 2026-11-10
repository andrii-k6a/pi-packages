export type ReviewOutputContract = {
  kind: 'finder' | 'verifier';
  fileMode: boolean;
  cwd: string;
  earlierIds?: string[];
};

/** Self-contained so the built-in script and durable structured_output use the same checks. */
export function createReviewOutputChecks(fileMode: boolean, cwd: string) {
  function normalizedPath(value: string): string {
    const windows = /^[a-z]:[\\/]/i.test(cwd);
    const path = windows ? value.replace(/\\/g, '/') : value;
    if (
      !path ||
      path.startsWith('/') ||
      (windows && /^[a-z]:/i.test(path)) ||
      /^[a-z]:[\\/]/i.test(path) ||
      path.includes('\0')
    ) {
      throw new Error('Expected a path relative to pathBase');
    }
    const parts: string[] = [];
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length || parts[parts.length - 1] === '..') {
          if (!fileMode) throw new Error('Path leaves the repository');
          parts.push('..');
        } else parts.pop();
      } else parts.push(part);
    }
    if (!parts.length) throw new Error('Expected a file path');
    return parts.join('/');
  }
  function checkedText(value: unknown, max: number, allowEmpty = false): string {
    if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
      throw new Error('Invalid review text: required text must contain non-whitespace characters');
    }
    return value;
  }
  function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid review output object');
    }
    return value as Record<string, unknown>;
  }
  function checkedLocation(input: unknown) {
    const value = object(input);
    if (!Number.isSafeInteger(value.line) || (value.line as number) < 1) {
      throw new Error('Invalid review location');
    }
    return { file: normalizedPath(checkedText(value.file, 500)), line: value.line as number };
  }
  function checkedLimitations(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 5) throw new Error('Invalid review limitations');
    return value.map((item) => checkedText(item, 600));
  }
  function checkedFinding(input: unknown) {
    const value = object(input);
    const location = checkedLocation(value);
    if (![1, 2, 3].includes(value.priority as number)) throw new Error('Invalid review priority');
    if (
      !Array.isArray(value.references) ||
      !value.references.length ||
      value.references.length > 5
    ) {
      throw new Error('Invalid review references');
    }
    return {
      ...location,
      summary: checkedText(value.summary, 240),
      evidence: checkedText(value.evidence, 1000),
      priority: value.priority,
      scenario: checkedText(value.scenario, 800),
      alternative: checkedText(value.alternative, 600, true),
      references: value.references.map((input) => {
        const reference = object(input);
        return {
          ...checkedLocation(reference),
          observation: checkedText(reference.observation, 400)
        };
      })
    };
  }
  function validateOutput(
    input: unknown,
    kind: 'finder' | 'verifier',
    earlierIds?: string[]
  ): void {
    const value = object(input);
    checkedLimitations(value.limitations);
    if (kind === 'finder') {
      if (!Array.isArray(value.candidates) || value.candidates.length > 5)
        throw new Error('Invalid candidates');
      value.candidates.forEach(checkedFinding);
    } else {
      checkedFinding(value);
      if (!['CONFIRMED', 'REFUTED', 'UNCERTAIN'].includes(value.verdict as string))
        throw new Error('Invalid verdict');
      checkedText(value.reason, 1000);
      checkedText(value.counterevidence, 800, true);
      if (
        value.duplicateOf !== undefined &&
        (typeof value.duplicateOf !== 'string' ||
          (value.duplicateOf &&
            earlierIds !== undefined &&
            !earlierIds.includes(value.duplicateOf)))
      ) {
        throw new Error('Invalid duplicate candidate: use an earlier candidate ID');
      }
    }
  }
  return {
    normalizedPath,
    checkedText,
    checkedLocation,
    checkedLimitations,
    checkedFinding,
    validateOutput
  };
}

export function reviewOutputContract(schema: unknown): ReviewOutputContract | undefined {
  return (schema as { 'x-workflow-review'?: ReviewOutputContract })?.['x-workflow-review'];
}

export function validateReviewOutput(value: unknown, contract: ReviewOutputContract): void {
  createReviewOutputChecks(contract.fileMode, contract.cwd).validateOutput(
    value,
    contract.kind,
    contract.earlierIds
  );
}
