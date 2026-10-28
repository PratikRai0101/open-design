// OpenCode resolves the tool schemas behind every MCP server *it* declares,
// after the daemon has handed over `OPENCODE_CONFIG_CONTENT`. Those schemas
// ride on every provider request, so a run can be over its context window
// even when the composed prompt is comfortably inside it — exactly the shape
// #9118 reports (462,317 bytes of tool definitions against a 128k window).
//
// This module asks each configured server for its `tools/list` payload so the
// preflight can budget the static request the child is about to build. It
// measures the descriptors *OpenCode will use*, parsed back out of the config
// JSON the daemon already produced, so auth headers and env stay in one place.
//
// Measurement is best-effort by design:
//   - a server that is unreachable, slow, or refuses is reported as
//     unmeasured, never as zero. An unreachable server is not evidence that
//     the run fits, and it is also not evidence that it doesn't.
//   - successes are cached per connection descriptor, so only the first run
//     against a given server pays the handshake.
//   - the whole measurement is bounded, so a hung server cannot delay run
//     start indefinitely.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const DEFAULT_SERVER_TIMEOUT_MS = 2_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 4_000;
const CLIENT_INFO = { name: 'open-design-preflight', version: '1' };

export interface MeasuredMcpServer {
  serverId: string;
  bytes: number;
  toolCount: number;
}

export interface McpToolSchemaMeasurement {
  /** Summed UTF-8 bytes of every measured server's tool definitions. */
  bytes: number;
  /** Total tool definitions measured across all reachable servers. */
  toolCount: number;
  measured: MeasuredMcpServer[];
  /** Servers whose tool schemas this preflight could not observe. */
  unmeasuredServerIds: string[];
}

type OpenCodeLocalServer = {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
};

type OpenCodeRemoteServer = {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
};

type OpenCodeMcpEntry = OpenCodeLocalServer | OpenCodeRemoteServer;

const measurementCache = new Map<string, { bytes: number; toolCount: number }>();

/** Test seam: the cache is process-wide, and tests must not inherit entries. */
export function _resetMcpToolSchemaMeasurementCache(): void {
  measurementCache.clear();
}

function isEnabledEntry(entry: OpenCodeMcpEntry): boolean {
  return entry.enabled !== false;
}

// Stable across runs for the same server: only the fields that select the
// endpoint or change the tool list participates. Secrets are hashed out by
// including the header *names* only, so a rotated OAuth token does not
// invalidate the measurement but a different server does.
function descriptorCacheKey(entry: OpenCodeMcpEntry): string {
  if (entry.type === 'local') {
    return JSON.stringify(['local', entry.command, entry.environment ?? {}]);
  }
  return JSON.stringify(['remote', entry.url, Object.keys(entry.headers ?? {}).sort()]);
}

function parseOpenCodeMcpEntries(configContent: string): Array<[string, OpenCodeMcpEntry]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configContent);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const mcp = (parsed as { mcp?: unknown }).mcp;
  if (!mcp || typeof mcp !== 'object') return [];

  const entries: Array<[string, OpenCodeMcpEntry]> = [];
  for (const [serverId, raw] of Object.entries(mcp as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    if (candidate.type === 'local') {
      const command = candidate.command;
      if (!Array.isArray(command) || command.length === 0) continue;
      const bin = command[0];
      if (typeof bin !== 'string' || !bin) continue;
      const entry: OpenCodeLocalServer = {
        type: 'local',
        command: [bin, ...command.slice(1).map((arg) => String(arg))],
      };
      if (candidate.environment && typeof candidate.environment === 'object') {
        entry.environment = candidate.environment as Record<string, string>;
      }
      if (typeof candidate.enabled === 'boolean') entry.enabled = candidate.enabled;
      entries.push([serverId, entry]);
      continue;
    }
    if (candidate.type === 'remote' && typeof candidate.url === 'string' && candidate.url) {
      const entry: OpenCodeRemoteServer = {
        type: 'remote',
        url: candidate.url,
      };
      if (candidate.headers && typeof candidate.headers === 'object') {
        entry.headers = candidate.headers as Record<string, string>;
      }
      if (typeof candidate.enabled === 'boolean') entry.enabled = candidate.enabled;
      entries.push([serverId, entry]);
    }
  }
  return entries;
}

function buildTransport(entry: OpenCodeMcpEntry): Transport {
  if (entry.type === 'local') {
    const [command = '', ...args] = entry.command;
    return new StdioClientTransport({
      command,
      args,
      env: { ...(process.env as Record<string, string>), ...(entry.environment ?? {}) },
      stderr: 'ignore',
    });
  }
  const url = new URL(entry.url);
  const options = entry.headers ? { requestInit: { headers: entry.headers } } : {};
  // `/sse`-style endpoints speak the legacy transport; everything else is
  // the streamable HTTP transport OpenCode uses.
  if (url.pathname.replace(/\/+$/, '').endsWith('/sse')) {
    return new SSEClientTransport(url, options);
  }
  // The SDK's own `Transport` interface declares optional members without
  // `| undefined`, so under this repo's `exactOptionalPropertyTypes` the
  // class is not structurally assignable even though `connect()` accepts it.
  return new StreamableHTTPClientTransport(url, options) as unknown as Transport;
}

async function measureServer(
  entry: OpenCodeMcpEntry,
  timeoutMs: number,
): Promise<{ bytes: number; toolCount: number } | null> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close().catch(() => {});
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
    });
    const measured = (async () => {
      await client.connect(buildTransport(entry));
      const listed = await client.listTools();
      const tools = Array.isArray(listed?.tools) ? listed.tools : [];
      let bytes = 0;
      for (const tool of tools) {
        bytes += Buffer.byteLength(JSON.stringify(tool), 'utf8') + 1;
      }
      return { bytes, toolCount: tools.length };
    })();
    return await Promise.race([measured, timeout]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    await close();
  }
}

/**
 * Measure the tool schemas OpenCode will resolve for the MCP servers in
 * `configContent` (the exact JSON handed to the child as
 * `OPENCODE_CONFIG_CONTENT`). Returns zero bytes plus every server id in
 * `unmeasuredServerIds` when the config declares none.
 */
export async function measureOpenCodeMcpToolSchemaBytes(
  configContent: string | null | undefined,
  options: { serverTimeoutMs?: number; totalTimeoutMs?: number } = {},
): Promise<McpToolSchemaMeasurement> {
  const measurement: McpToolSchemaMeasurement = {
    bytes: 0,
    toolCount: 0,
    measured: [],
    unmeasuredServerIds: [],
  };
  if (typeof configContent !== 'string' || !configContent.trim()) return measurement;

  const entries = parseOpenCodeMcpEntries(configContent).filter(([, entry]) =>
    isEnabledEntry(entry),
  );
  if (entries.length === 0) return measurement;

  const serverTimeoutMs = options.serverTimeoutMs ?? DEFAULT_SERVER_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  let totalTimer: NodeJS.Timeout | undefined;
  const totalExpired = new Promise<null>((resolve) => {
    totalTimer = setTimeout(() => resolve(null), totalTimeoutMs);
    totalTimer.unref?.();
  });

  try {
    // Each server commits its result as it resolves so a total-deadline
    // expiry still keeps whatever finished in time.
    const pending = Promise.all(
      entries.map(async ([serverId, entry]) => {
        const cacheKey = descriptorCacheKey(entry);
        const result = measurementCache.get(cacheKey) ?? (await measureServer(entry, serverTimeoutMs));
        if (!result) {
          measurement.unmeasuredServerIds.push(serverId);
          return;
        }
        measurementCache.set(cacheKey, result);
        measurement.measured.push({ serverId, ...result });
        measurement.bytes += result.bytes;
        measurement.toolCount += result.toolCount;
      }),
    );
    // A server that never answers must not hold up run start: the total
    // deadline bounds the whole measurement.
    await Promise.race([pending, totalExpired]);
    for (const [serverId] of entries) {
      const settled =
        measurement.measured.some((m) => m.serverId === serverId) ||
        measurement.unmeasuredServerIds.includes(serverId);
      if (!settled) measurement.unmeasuredServerIds.push(serverId);
    }
    return measurement;
  } finally {
    if (totalTimer) clearTimeout(totalTimer);
  }
}
