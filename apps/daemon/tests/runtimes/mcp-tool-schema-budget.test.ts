import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  _resetMcpToolSchemaMeasurementCache,
  measureOpenCodeMcpToolSchemaBytes,
} from '../../src/runtimes/mcp-tool-schema-budget.js';

let workDir: string;
let serverScript: string;

// Same shape as the config the daemon hands OpenCode via
// OPENCODE_CONFIG_CONTENT: `mcp[id] = { type, command[], enabled }`.
function localServerConfig(script: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    mcp: {
      'fake-server': {
        type: 'local',
        command: [process.execPath, script],
        enabled: true,
        ...overrides,
      },
    },
  });
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'od-mcp-schema-budget-'));
  serverScript = join(workDir, 'fake-mcp.cjs');
  await writeFile(
    serverScript,
    `
const readline = require('node:readline');
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
    return;
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'alpha', description: 'first', inputSchema: { type: 'object', properties: {} } },
      { name: 'beta', description: 'second', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } },
    ] } });
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unsupported' } });
});
`,
    'utf8',
  );
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('measureOpenCodeMcpToolSchemaBytes', () => {
  it('measures nothing when the OpenCode config declares no MCP servers', async () => {
    for (const config of [null, undefined, '', 'not json', '{}', '{"mcp":{}}']) {
      expect(await measureOpenCodeMcpToolSchemaBytes(config)).toEqual({
        bytes: 0,
        toolCount: 0,
        measured: [],
        unmeasuredServerIds: [],
      });
    }
  });

  it('sums the tool definitions OpenCode would re-send on every request', async () => {
    _resetMcpToolSchemaMeasurementCache();
    const measurement = await measureOpenCodeMcpToolSchemaBytes(localServerConfig(serverScript));

    expect(measurement.unmeasuredServerIds).toEqual([]);
    expect(measurement.toolCount).toBe(2);
    expect(measurement.measured).toEqual([
      { serverId: 'fake-server', bytes: expect.any(Number), toolCount: 2 },
    ]);
    // Two small tools: measured, non-zero, and far below any context window.
    expect(measurement.bytes).toBeGreaterThan(0);
    expect(measurement.bytes).toBeLessThan(2_000);
  });

  it('skips a disabled server instead of spawning it', async () => {
    _resetMcpToolSchemaMeasurementCache();
    const measurement = await measureOpenCodeMcpToolSchemaBytes(
      localServerConfig(serverScript, { enabled: false }),
    );

    expect(measurement).toEqual({
      bytes: 0,
      toolCount: 0,
      measured: [],
      unmeasuredServerIds: [],
    });
  });

  // An unreachable server is neither evidence that the run fits nor evidence
  // that it doesn't. It must be reported, never silently counted as zero
  // bytes of tool schema.
  it('reports an unreachable server as unmeasured rather than empty', async () => {
    _resetMcpToolSchemaMeasurementCache();
    const measurement = await measureOpenCodeMcpToolSchemaBytes(
      localServerConfig(serverScript, { command: [join(workDir, 'does-not-exist')] }),
      { serverTimeoutMs: 500, totalTimeoutMs: 1_000 },
    );

    expect(measurement.bytes).toBe(0);
    expect(measurement.toolCount).toBe(0);
    expect(measurement.unmeasuredServerIds).toEqual(['fake-server']);
  });
});
