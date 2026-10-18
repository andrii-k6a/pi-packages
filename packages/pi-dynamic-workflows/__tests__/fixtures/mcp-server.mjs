// A minimal MCP server over stdio for tests: newline-delimited JSON-RPC.
// MCP_LOG (optional) names a file that records `spawn`, every tool call, and `exit`.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (line) => {
  if (process.env.MCP_LOG) appendFileSync(process.env.MCP_LOG, `${line}\n`);
};
log('spawn');

const object = (properties = {}, required = []) => ({ type: 'object', properties, required });
const tools = process.env.MCP_TOOLS
  ? JSON.parse(process.env.MCP_TOOLS).map((name) => ({ name, description: name, inputSchema: object() }))
  : [
  { name: 'echo', description: 'Echo text back', inputSchema: object({ text: { type: 'string' } }, ['text']) },
  { name: 'read_env', description: 'Read an environment variable of the server', inputSchema: object({ name: { type: 'string' } }, ['name']) },
  { name: 'fail', description: 'Always fails', inputSchema: object() },
  { name: 'get_time', description: 'Not on the allowlist', inputSchema: object() },
  { name: 'delete_all', description: 'Dangerous; hidden by Pi configuration', inputSchema: object() }
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

function call(name, args) {
  log(`call ${name}${args?.text ? ` ${args.text}` : ''}`);
  switch (name) {
    case 'echo':
      return text(`echo: ${args.text}`);
    case 'read_env':
      return text(`${args.name}=${process.env[args.name] ?? ''}`);
    case 'fail':
      return text('boom from server', true);
    default:
      return text(`${name} done`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return; // notifications
  switch (message.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1.0.0' }
        }
      });
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: message.id, result: { tools } });
      break;
    case 'tools/call':
      if (process.env.MCP_PROTOCOL_ERROR) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: process.env.MCP_PROTOCOL_ERROR } });
        break;
      }
      send({ jsonrpc: '2.0', id: message.id, result: call(message.params.name, message.params.arguments) });
      break;
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
  }
});
lines.on('close', () => {
  log('exit');
  process.exit(0);
});
