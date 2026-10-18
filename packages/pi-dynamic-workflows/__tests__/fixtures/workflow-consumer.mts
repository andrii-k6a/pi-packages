/// <reference types="@andrii-k6a/pi-dynamic-workflows/workflow" />

// Compile-only probes: execute neither these calls nor their intentionally invalid assignments.
const prose = await agent('prose');
const nullableProse: string | null = prose;
// @ts-expect-error Ordinary executor failure can yield null.
const nonNullableProse: string = prose;

const proseWithOptions = await agent('prose', { label: 'prose' });
const nullableProseWithOptions: string | null = proseWithOptions;
// @ts-expect-error A result generic requires a schema, not empty prose options.
await agent<{ count: number }>('prose', {});
// @ts-expect-error Prose options cannot claim structured output.
await agent<{ count: number }>('prose', { label: 'prose' });
// @ts-expect-error An explicitly absent schema still means prose output.
await agent<{ count: number }>('prose', { schema: undefined });

const schema = { type: 'object', properties: { count: { type: 'number' } } };
const structured = await agent('structured', { schema });
// @ts-expect-error Schema output defaults to unknown, not string.
const incorrectString: string | null = structured;
// @ts-expect-error Narrow schema output before reading its fields.
structured.count;

const typed = await agent<{ count: number }>('structured', { schema });
const nullableTyped: { count: number } | null = typed;
// @ts-expect-error Typed schema results still require null handling.
const nonNullableTyped: { count: number } = typed;
if (typed !== null) {
  const count: number = typed.count;
}

const optionalSchema: WorkflowAgentOptions = {};
const uncertain = await agent('maybe structured', optionalSchema);
// @ts-expect-error An optional schema cannot promise prose output.
const uncertainString: string | null = uncertain;
// @ts-expect-error A result generic requires a schema that is guaranteed to be present.
await agent<{ count: number }>('maybe structured', optionalSchema);

const branches = await parallel([async () => 1]);
const nullableBranches: Array<number | null> = branches;
// @ts-expect-error parallel catches ordinary thrown branch errors.
const nonNullableBranches: number[] = branches;

const stages = await pipeline([1], () => 'done');
const nullableStages: Array<string | null> = stages;
// @ts-expect-error pipeline catches ordinary thrown stage errors.
const nonNullableStages: string[] = stages;

// log() takes any number of values, like console.log.
log('count:', 3, { nested: [1, 2] });
log();
