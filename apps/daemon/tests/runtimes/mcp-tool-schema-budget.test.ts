import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetMcpToolSchemaMeasurementCache,
  measureOpenCodeMcpToolSchemaBytes,
  parseJsonc,
} from '../../src/runtimes/mcp-tool-schema-budget.js';

let workDir: string;
let serverScript: string;

// Same shape as the config the daemon hands OpenCode via
// OPENCODE_CONFIG_CONTENT: `mcp[id] = { type, command[], enabled }`.
function localServerEntry(script: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'local',
    command: [process.execPath, script],
    enabled: true,
    ...overrides,
  };
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

beforeEach(() => {
  _resetMcpToolSchemaMeasurementCache();
});

// `env` points HOME/XDG at an empty scratch dir unless a test supplies its own,
// so the developer's real ~/.config/opencode never leaks into a measurement.
type ScratchEnv = { HOME: string; XDG_CONFIG_HOME: string };

async function scratchEnv(): Promise<ScratchEnv> {
  const home = await mkdtemp(join(tmpdir(), 'od-mcp-home-'));
  return { HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
}

async function writeGlobalConfig(
  env: ScratchEnv,
  fileName: string,
  contents: string,
): Promise<string> {
  const dir = join(env.XDG_CONFIG_HOME, 'opencode');
  await mkdir(dir, { recursive: true });
  const file = join(dir, fileName);
  await writeFile(file, contents, 'utf8');
  return file;
}

describe('parseJsonc', () => {
  it('strips comments and trailing commas without touching strings', () => {
    const parsed = parseJsonc(`{
      // a line comment
      "url": "https://example.test//not-a-comment",
      /* a block comment */
      "list": [1, 2, ],
    }`);

    expect(parsed).toEqual({
      url: 'https://example.test//not-a-comment',
      list: [1, 2],
    });
  });
});

describe('measureOpenCodeMcpToolSchemaBytes', () => {
  it('measures nothing when neither config layer declares MCP servers', async () => {
    const env = await scratchEnv();
    for (const overlayContent of [null, undefined, '', 'not json', '{}', '{"mcp":{}}']) {
      const measurement = await measureOpenCodeMcpToolSchemaBytes({ overlayContent, env });
      expect(measurement).toMatchObject({
        bytes: 0,
        toolCount: 0,
        measured: [],
        unmeasuredServerIds: [],
      });
    }
  });

  it('sums the tool definitions OpenCode would re-send on every request', async () => {
    const env = await scratchEnv();
    const measurement = await measureOpenCodeMcpToolSchemaBytes({
      overlayContent: JSON.stringify({
        mcp: { 'fake-server': localServerEntry(serverScript) },
      }),
      env,
    });

    expect(measurement.unmeasuredServerIds).toEqual([]);
    expect(measurement.toolCount).toBe(2);
    expect(measurement.measured).toEqual([
      { serverId: 'fake-server', bytes: expect.any(Number), toolCount: 2 },
    ]);
    expect(measurement.bytes).toBeGreaterThan(0);
    expect(measurement.bytes).toBeLessThan(2_000);
    expect(measurement.configSources).toEqual(['OPENCODE_CONFIG_CONTENT']);
  });

  // Review on #9136, P1: `OPENCODE_CONFIG_CONTENT` is only the daemon's layer.
  // #9118's 462,317-byte server lived in the user's global opencode.jsonc, so
  // a measurement that only reads the overlay reports zero and lets the run
  // start — the exact gap this test pins.
  it('measures a server declared only in the global opencode.jsonc', async () => {
    const env = await scratchEnv();
    const globalFile = await writeGlobalConfig(
      env,
      'opencode.jsonc',
      `{
        // the oversized schema from #9118 lived in a file like this one
        "mcp": {
          "global-only": ${JSON.stringify(localServerEntry(serverScript))},
        },
      }`,
    );

    const measurement = await measureOpenCodeMcpToolSchemaBytes({ overlayContent: null, env });

    expect(measurement.measured.map((m) => m.serverId)).toEqual(['global-only']);
    expect(measurement.toolCount).toBe(2);
    expect(measurement.bytes).toBeGreaterThan(0);
    expect(measurement.configSources).toEqual([globalFile]);
  });

  it('merges both layers and lets the daemon overlay win per server id', async () => {
    const env = await scratchEnv();
    await writeGlobalConfig(
      env,
      'opencode.json',
      JSON.stringify({
        mcp: {
          shared: localServerEntry(serverScript),
          'global-only': localServerEntry(serverScript),
        },
      }),
    );

    const measurement = await measureOpenCodeMcpToolSchemaBytes({
      overlayContent: JSON.stringify({
        // Same id as the global entry: one server, not two, and the daemon's
        // descriptor is the one OpenCode runs.
        mcp: { shared: localServerEntry(serverScript) },
      }),
      env,
    });

    expect(measurement.measured.map((m) => m.serverId).sort()).toEqual([
      'global-only',
      'shared',
    ]);
    expect(measurement.toolCount).toBe(4);
    expect(measurement.configSources).toHaveLength(2);
  });

  it('skips a disabled server from either layer instead of spawning it', async () => {
    const env = await scratchEnv();
    await writeGlobalConfig(
      env,
      'opencode.json',
      JSON.stringify({ mcp: { off: localServerEntry(serverScript, { enabled: false }) } }),
    );

    expect(
      await measureOpenCodeMcpToolSchemaBytes({
        overlayContent: JSON.stringify({
          mcp: { 'overlay-off': localServerEntry(serverScript, { enabled: false }) },
        }),
        env,
      }),
    ).toMatchObject({ bytes: 0, toolCount: 0, measured: [], unmeasuredServerIds: [] });
  });

  // An unreachable server is neither evidence that the run fits nor evidence
  // that it doesn't. It must be reported, never silently counted as zero bytes
  // of tool schema.
  it('reports an unreachable server as unmeasured rather than empty', async () => {
    const env = await scratchEnv();
    const measurement = await measureOpenCodeMcpToolSchemaBytes(
      {
        overlayContent: JSON.stringify({
          mcp: {
            broken: localServerEntry(join(workDir, 'does-not-exist')),
          },
        }),
        env,
      },
      { serverTimeoutMs: 500, totalTimeoutMs: 1_000 },
    );

    expect(measurement.bytes).toBe(0);
    expect(measurement.toolCount).toBe(0);
    expect(measurement.unmeasuredServerIds).toEqual(['broken']);
  });
});
