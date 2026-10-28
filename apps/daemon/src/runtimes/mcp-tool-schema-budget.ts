// OpenCode resolves the tool schemas behind every MCP server *it* declares,
// then re-sends them on every provider request, so a run can be over its
// context window even when the composed prompt is comfortably inside it —
// exactly the shape #9118 reports (462,317 bytes of tool definitions against
// a 128k window).
//
// This module asks each server for its `tools/list` payload so the preflight
// can budget the static request the child is about to build.
//
// The set that matters is the *effective* one, not the daemon's overlay.
// OpenCode merges its config from several layers, and `OPENCODE_CONFIG_CONTENT`
// is only the last of them: the user's global `~/.config/opencode/opencode.json`
// (or `.jsonc`) stays active for every field the overlay does not mention. That
// is where #9118's oversized `rea` server actually lived. Measuring only the
// daemon overlay would pass a run that the global servers then blow past the
// window — the bug this guard exists to stop. So the resolver below reads the
// same layers OpenCode does and measures their union.
//
// Measurement is best-effort by design:
//   - a server that is unreachable, slow, or refuses is reported as
//     unmeasured, never as zero. An unreachable server is not evidence that
//     the run fits, and it is also not evidence that it doesn't.
//   - successes are cached per connection descriptor, so only the first run
//     against a given server pays the handshake.
//   - the whole measurement is bounded, so a hung server cannot delay run
//     start indefinitely.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
  /** Config layers that contributed to the measured set. */
  configSources: string[];
}

export interface EffectiveOpenCodeMcpSources {
  /** JSON handed to the child as `OPENCODE_CONFIG_CONTENT` (daemon overlay). */
  overlayContent?: string | null | undefined;
  /**
   * The environment the child will spawn with. `HOME` / `XDG_CONFIG_HOME` /
   * `OPENCODE_CONFIG` decide which global config layers apply, and a
   * sandboxed run may redirect them away from the daemon's own home.
   */
  env?: Record<string, string | undefined> | undefined;
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

/**
 * Strip `//` and block comments plus trailing commas from JSONC.
 *
 * OpenCode accepts `opencode.jsonc`, and #9118's oversized server was
 * declared in one. A regex is not safe here (a `//` inside a URL string would
 * truncate the document), so this walks the text and only strips outside
 * strings.
 */
export function parseJsonc(text: string): unknown {
  let out = '';
  let index = 0;
  let inString = false;
  let stringQuote = '';
  const pendingCommas: number[] = [];

  const flushPendingCommas = (keepLast: boolean) => {
    if (pendingCommas.length === 0) return;
    const last = pendingCommas.length - 1;
    for (let i = 0; i < pendingCommas.length; i += 1) {
      if (keepLast && i === last) out += ',';
    }
    pendingCommas.length = 0;
  };

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        index += 2;
        continue;
      }
      if (char === stringQuote) inString = false;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      // A pending comma directly before a string can never be trailing.
      flushPendingCommas(true);
      inString = true;
      stringQuote = char;
      out += char;
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }

    if (char === ',') {
      pendingCommas.push(1);
      index += 1;
      continue;
    }

    if (/\s/.test(char ?? '')) {
      // Whitespace does not decide whether a pending comma is trailing.
      if (pendingCommas.length > 0) pendingCommas.push(0);
      out += char;
      index += 1;
      continue;
    }

    if (char === '}' || char === ']') {
      // A comma followed only by whitespace before a closer is trailing.
      flushPendingCommas(false);
      out += char;
      index += 1;
      continue;
    }

    flushPendingCommas(true);
    out += char;
    index += 1;
  }
  flushPendingCommas(true);

  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function mcpMapFromConfig(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const mcp = (parsed as { mcp?: unknown }).mcp;
  if (!mcp || typeof mcp !== 'object') return null;
  return mcp as Record<string, unknown>;
}

/**
 * Config files OpenCode merges, in ascending precedence, for the *child's*
 * environment. Project `opencode.json` is deliberately absent: the daemon sets
 * `OPENCODE_DISABLE_PROJECT_CONFIG=1`, so that layer is off for these runs.
 */
export function resolveOpenCodeConfigFileCandidates(
  env: Record<string, string | undefined>,
): string[] {
  const candidates: string[] = [];
  const explicit = typeof env.OPENCODE_CONFIG === 'string' ? env.OPENCODE_CONFIG.trim() : '';
  const xdg =
    typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
  const home = typeof env.HOME === 'string' ? env.HOME.trim() : '';
  const configHome = xdg || (home ? path.join(home, '.config') : '');
  if (configHome) {
    candidates.push(path.join(configHome, 'opencode', 'opencode.json'));
    candidates.push(path.join(configHome, 'opencode', 'opencode.jsonc'));
  }
  // `OPENCODE_CONFIG` is an explicit pointer, so it outranks the global dir.
  if (explicit) candidates.push(explicit);
  return candidates;
}

async function readOpenCodeConfigMcp(
  env: Record<string, string | undefined>,
): Promise<{ entries: Record<string, unknown>; sources: string[] }> {
  const merged: Record<string, unknown> = {};
  const sources: string[] = [];
  for (const candidate of resolveOpenCodeConfigFileCandidates(env)) {
    let raw: string;
    try {
      raw = await readFile(candidate, 'utf8');
    } catch {
      continue;
    }
    const mcp = mcpMapFromConfig(parseJsonc(raw));
    if (!mcp) continue;
    sources.push(candidate);
    Object.assign(merged, mcp);
  }
  return { entries: merged, sources };
}

/**
 * The `mcp` map OpenCode will actually run with: the user's config layers
 * first, then the daemon overlay, which wins per server id because it is
 * merged last.
 */
export async function resolveEffectiveOpenCodeMcpConfig(
  sources: EffectiveOpenCodeMcpSources,
): Promise<{ mcp: Record<string, unknown>; configSources: string[] }> {
  const env = sources.env ?? (process.env as Record<string, string | undefined>);
  const global = await readOpenCodeConfigMcp(env);
  const overlay = mcpMapFromConfig(parseJsonc(sources.overlayContent ?? '')) ?? {};
  return {
    mcp: { ...global.entries, ...overlay },
    configSources: [
      ...global.sources,
      ...(Object.keys(overlay).length > 0 ? ['OPENCODE_CONFIG_CONTENT'] : []),
    ],
  };
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

function parseOpenCodeMcpEntries(
  mcp: Record<string, unknown>,
): Array<[string, OpenCodeMcpEntry]> {
  const entries: Array<[string, OpenCodeMcpEntry]> = [];
  for (const [serverId, raw] of Object.entries(mcp)) {
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
 * Measure the tool schemas OpenCode will resolve for this run's *effective*
 * MCP set — the user's config layers merged with the daemon overlay.
 *
 * This spawns the same MCP server commands OpenCode itself would spawn, with
 * a short per-server timeout, and caches each server's measurement so repeat
 * runs do not pay the handshake again.
 */
export async function measureOpenCodeMcpToolSchemaBytes(
  sources: EffectiveOpenCodeMcpSources,
  options: { serverTimeoutMs?: number; totalTimeoutMs?: number } = {},
): Promise<McpToolSchemaMeasurement> {
  const measurement: McpToolSchemaMeasurement = {
    bytes: 0,
    toolCount: 0,
    measured: [],
    unmeasuredServerIds: [],
    configSources: [],
  };
  const effective = await resolveEffectiveOpenCodeMcpConfig(sources);
  measurement.configSources = effective.configSources;

  const entries = parseOpenCodeMcpEntries(effective.mcp).filter(([, entry]) =>
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
