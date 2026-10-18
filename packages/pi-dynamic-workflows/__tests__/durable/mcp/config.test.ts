import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import {
  createToolMatcher,
  isHiddenByPi,
  loadPiMcpServers,
  loadWorkflowMcpAllowlist,
  mcpToolName,
  mcpToolNames,
  parseWorkflowMcpAllowlist,
  resolveConfigValue,
  resolveConfigValueAsync,
  resolveHeaders,
  unsupportedReason,
  workflowMcpPath
} from '../../../src/durable/mcp/config.js';

let directory: string;
let agentDir: string;
let project: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-workflow-mcp-config-'));
  agentDir = join(directory, 'agent');
  project = join(directory, 'project');
  await mkdir(join(agentDir, 'pi-dynamic-workflows'), { recursive: true });
  await mkdir(join(project, '.pi'), { recursive: true });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const write = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));

test('the workflows allowlist is strict: unknown keys, bad names, and bad patterns fail loudly', () => {
  const parse = (value: unknown) => parseWorkflowMcpAllowlist(value, '/cfg/mcp.json');

  assert.deepEqual(
    parse({ servers: { github: { tools: ['search_*', 'get_issue', 'get_issue'] }, docs: {} } }),
    {
      servers: { github: { tools: ['search_*', 'get_issue'] }, docs: {} }
    }
  );
  assert.throws(() => parse([]), /expected an object/);
  assert.throws(() => parse({ servers: {}, extra: 1 }), /unknown key "extra"/);
  assert.throws(() => parse({}), /"servers" must be an object/);
  assert.throws(() => parse({ servers: { 'bad name': {} } }), /may use only letters, digits/);
  assert.throws(() => parse({ servers: { 'a-b': {}, a_b: {} } }), /are the same server/);
  assert.throws(() => parse({ servers: { a: { nope: 1 } } }), /server "a" has unknown key "nope"/);
  assert.throws(() => parse({ servers: { a: { tools: ['ok', ''] } } }), /array of tool names/);
  assert.throws(() => parse({ servers: { a: { tools: 'echo' } } }), /array of tool names/);
});

test('loadWorkflowMcpAllowlist treats a missing file as approving nothing and reports bad JSON', async () => {
  assert.deepEqual(loadWorkflowMcpAllowlist(agentDir), { servers: {} });
  await writeFile(workflowMcpPath(agentDir), '{ nope');
  assert.throws(
    () => loadWorkflowMcpAllowlist(agentDir),
    /Invalid dynamic workflow MCP configuration at .*invalid JSON/
  );
  await write(workflowMcpPath(agentDir), { servers: { fs: { tools: ['read_*'] } } });
  assert.deepEqual(loadWorkflowMcpAllowlist(agentDir).servers.fs.tools, ['read_*']);
});

test("Pi's mcp.json is read for global servers, and project servers only when the project is trusted", async () => {
  await write(join(agentDir, 'mcp.json'), {
    mcpServers: {
      fs: { command: 'npx', args: ['-y', 'server-fs'] },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Pi expands this config placeholder, not JavaScript.
      docs: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
      broken: { command: 42 },
      'a-b': { command: 'x' },
      a_b: { command: 'y' }
    }
  });
  await write(join(project, '.pi', 'mcp.json'), {
    mcpServers: {
      fs: { enabled: false },
      local: { command: './tool.sh' },
      ghost: { enabled: false },
      docs: { url: 'https://example.com/mcp', enabled: true, args: ['nope'] }
    }
  });

  const untrusted = loadPiMcpServers({ agentDir, cwd: project, projectTrusted: false });
  assert.deepEqual([...untrusted.servers.keys()].sort(), ['a-b', 'docs', 'fs']);
  assert.equal(untrusted.servers.get('fs')?.config.enabled, undefined);
  assert.ok(
    untrusted.errors.some((error) => error.includes('server "broken" needs either "command"'))
  );
  assert.ok(untrusted.errors.some((error) => error.includes('server "a_b" conflicts with "a-b"')));

  const trusted = loadPiMcpServers({ agentDir, cwd: project, projectTrusted: true });
  assert.deepEqual([...trusted.servers.keys()].sort(), ['a-b', 'docs', 'fs', 'local']);
  // A project entry with only enabled/exposure/toolExposure overrides the global server in place.
  assert.equal(trusted.servers.get('fs')?.config.enabled, false);
  assert.equal(trusted.servers.get('fs')?.scope, 'global');
  assert.equal(trusted.servers.get('local')?.scope, 'project');
  assert.ok(
    trusted.errors.some((error) => error.includes('server "ghost" needs "command" or "url"'))
  );
});

test('servers that need OAuth or a /login token are reported as unsupported', () => {
  assert.equal(unsupportedReason({ url: 'https://x.test/mcp' } as never), undefined);
  assert.match(unsupportedReason({ url: 'https://x.test/mcp', oauth: {} } as never) ?? '', /OAuth/);
  assert.match(
    unsupportedReason({ url: 'https://x.test/mcp', auth: { provider: 'p' } } as never) ?? '',
    /\/login/
  );
});

test('config values resolve like Pi: environment templates, escapes, and whole-value commands', () => {
  const env = { TOKEN: 'abc', EMPTY: '' };
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Pi, not JavaScript, expands this placeholder.
  assert.equal(resolveConfigValue('Bearer ${TOKEN}', 'h', env), 'Bearer abc');
  assert.equal(resolveConfigValue('$TOKEN-$TOKEN', 'h', env), 'abc-abc');
  assert.equal(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Invalid placeholders must remain literal.
    resolveConfigValue('cost $$5 and $!bang ${not a var}', 'h', env),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Expected literal output of the config parser.
    'cost $5 and !bang ${not a var}'
  );
  assert.equal(resolveConfigValue('plain', 'h', env), 'plain');
  assert.throws(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Exercise a missing Pi environment variable.
    () => resolveConfigValue('${MISSING}', 'server "x" env "A"', env),
    /server "x" env "A": environment variable MISSING is not set/
  );
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Exercise an empty Pi environment variable.
  assert.throws(() => resolveConfigValue('${EMPTY}', 'd', env), /EMPTY is not set/);

  assert.equal(resolveConfigValue('!echo from-command', 'h'), 'from-command');
  // Failures name the setting, never the command or what it printed.
  assert.throws(
    () => resolveConfigValue('!echo SECRET-OUTPUT; exit 3', 'server "x" header "Authorization"'),
    (error: Error) =>
      /server "x" header "Authorization": the command did not produce a value/.test(
        error.message
      ) && !error.message.includes('SECRET-OUTPUT')
  );
});

test('tool names follow Pi: sanitized, shortened with a hash, and unique per server', () => {
  assert.equal(mcpToolName('my-server', 'get.items'), 'mcp__my_server__get_items');
  const long = mcpToolName('s', 'x'.repeat(100));
  assert.equal(long.length, 64);
  assert.match(long, /^mcp__s__x+_[0-9a-f]{8}$/);
  const taken = new Set([mcpToolName('s', 'a-b')]);
  const clash = mcpToolName('s', 'a_b', (name) => taken.has(name));
  assert.notEqual(clash, 'mcp__s__a_b');
  assert.match(clash, /^mcp__s__a_b_[0-9a-f]{8}$/);
});

test('every colliding MCP tool gets a stable name independent of catalog order', () => {
  const tools = ['get-item', 'get_item', 'get.item', 'unique'];
  const first = mcpToolNames('server', tools);
  const reversed = mcpToolNames('server', [...tools].reverse());
  for (const tool of tools) assert.equal(first.get(tool), reversed.get(tool));
  assert.equal(new Set(first.values()).size, tools.length);
  for (const tool of tools.slice(0, 3)) {
    assert.match(first.get(tool) ?? '', /^mcp__server__get_item_[0-9a-f]{8}$/);
  }
  assert.equal(first.get('unique'), 'mcp__server__unique');
});

test('tool matchers take exact names and * patterns; Pi hides tools through toolExposure', () => {
  const matches = createToolMatcher(['echo', 'get_*', 'a.b*']);
  assert.deepEqual(
    ['echo', 'echo2', 'get_', 'get_issue', 'xget_issue', 'a.bc', 'aXb'].filter(matches),
    ['echo', 'get_', 'get_issue', 'a.bc']
  );

  const config = {
    command: 'x',
    exposure: 'direct',
    toolExposure: { 'delete_*': 'hidden', delete_draft: 'direct', 'get_*': 'codemode' }
  } as never;
  assert.equal(isHiddenByPi(config, 'delete_all'), true);
  assert.equal(isHiddenByPi(config, 'delete_draft'), false);
  assert.equal(isHiddenByPi(config, 'get_issue'), false);
  assert.equal(isHiddenByPi(config, 'search'), false);
  assert.equal(
    isHiddenByPi(
      { command: 'x', exposure: 'hidden', toolExposure: { search: 'direct' } } as never,
      'search'
    ),
    false
  );
  assert.equal(isHiddenByPi({ command: 'x', exposure: 'hidden' } as never, 'search'), true);
});

test('config commands resolve without blocking the event loop, with the same error rules', async () => {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 10);
  try {
    assert.equal(
      await resolveConfigValueAsync('!sleep 0.3; echo from-command', 'h'),
      'from-command'
    );
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks >= 5, `timers kept firing while the command ran (${ticks} ticks)`);

  // Values without a command are resolved exactly as before.
  assert.equal(await resolveConfigValueAsync('Bearer $TOKEN', 'h', { TOKEN: 'abc' }), 'Bearer abc');
  await assert.rejects(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Exercise a missing Pi environment variable.
    () => resolveConfigValueAsync('${MISSING}', 'server "x" env "A"', {}),
    /server "x" env "A": environment variable MISSING is not set/
  );
  // Failures name the setting, never the command or what it printed.
  await assert.rejects(
    () => resolveConfigValueAsync('!echo SECRET-OUTPUT; exit 3', 'server "x" header "Auth"'),
    (error: Error) =>
      /server "x" header "Auth": the command did not produce a value/.test(error.message) &&
      !error.message.includes('SECRET-OUTPUT')
  );
  await assert.rejects(
    () => resolveConfigValueAsync('!true', 'server "x" env "EMPTY"'),
    /did not produce a value/
  );

  assert.deepEqual(await resolveHeaders({ A: '!echo one', B: 'two' }, 'MCP server "x"'), {
    A: 'one',
    B: 'two'
  });
  assert.equal(await resolveHeaders(undefined, 'MCP server "x"'), undefined);
});
