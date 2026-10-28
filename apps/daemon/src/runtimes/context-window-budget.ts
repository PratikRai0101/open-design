import type { RuntimePromptBudgetError } from './types.js';

// The daemon's token-estimate convention, shared with the
// `prompt_budget_v1` diagnostic emitted by the ACP transport
// (`agent-protocol/acp/session.ts`, `tokenEstimateMethod:
// 'utf8_bytes_div_3_ceil_v1'`). Deliberately conservative: provider tool
// schemas and source code run closer to 3 UTF-8 bytes per token than to
// prose's ~4, so dividing by 3 over-estimates a prose-heavy prompt but
// does not under-estimate the schema-heavy payloads that actually
// overflow a window.
const BYTES_PER_TOKEN = 3;

export interface StaticPromptContextBudgetInput {
  /** Display name of the runtime, e.g. "OpenAI API via OpenCode". */
  agentName: string;
  /** Model id the run will be billed against, as the provider sees it. */
  model: string;
  /** UTF-8 size of the composed prompt this run will send. */
  promptBytes: number;
  /** Window the runtime declares for this model. */
  contextWindowTokens: number;
  /** Tokens that must stay free for the model's reply. */
  outputTokenReserveTokens: number;
}

export interface StaticPromptContextBudgetError extends RuntimePromptBudgetError {
  promptTokenEstimate: number;
  contextWindowTokens: number;
}

export function estimatePromptTokens(promptBytes: number): number {
  if (!Number.isFinite(promptBytes) || promptBytes <= 0) return 0;
  return Math.ceil(promptBytes / BYTES_PER_TOKEN);
}

/**
 * Refuses a run whose composed prompt cannot fit the context window the
 * runtime is about to declare for it.
 *
 * The static part of a prompt — system text, tool schemas, skills — is
 * present in every request and cannot be removed by compaction, which
 * only trims conversation history. When the prompt is already over
 * budget before the model has said anything, a runtime that answers by
 * compacting therefore re-fires on the very next step and never
 * converges: it spends the provider balance without making progress.
 * Failing here costs one error message instead of that loop.
 *
 * Returns null when the window is unknown (0, negative, or NaN): an
 * absent window is not evidence that this prompt is too large, and
 * inventing a failure would block runs that work.
 */
export function checkStaticPromptContextBudget(
  input: StaticPromptContextBudgetInput,
): StaticPromptContextBudgetError | null {
  const { contextWindowTokens } = input;
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return null;

  const outputTokenReserveTokens = Number.isFinite(input.outputTokenReserveTokens)
    ? Math.max(input.outputTokenReserveTokens, 0)
    : 0;
  const limit = contextWindowTokens - outputTokenReserveTokens;
  const promptTokenEstimate = estimatePromptTokens(input.promptBytes);
  if (promptTokenEstimate <= limit) return null;

  return {
    code: 'AGENT_PROMPT_TOO_LARGE',
    message:
      `${input.agentName} declares a ${contextWindowTokens.toLocaleString('en-US')} token context window for ${input.model}, ` +
      `and this run's prompt already estimates at ${promptTokenEstimate.toLocaleString('en-US')} tokens before any room for the reply ` +
      `(${limit.toLocaleString('en-US')} available). Auto-compaction only trims conversation history, so it cannot shrink a prompt that is ` +
      'over budget on its own and would re-fire on every step instead of making progress. ' +
      'Reduce the selected skills/design-system context, start a new conversation, or use a model whose context window has room for this prompt.',
    bytes: input.promptBytes,
    limit,
    promptTokenEstimate,
    contextWindowTokens,
  };
}
