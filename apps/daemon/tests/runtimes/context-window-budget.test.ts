import { describe, expect, it } from 'vitest';

import {
  BYOK_OPENCODE_CONTEXT_TOKEN_LIMIT,
  BYOK_OPENCODE_OUTPUT_TOKEN_LIMIT,
} from '../../src/runtimes/byok-opencode.js';
import {
  checkStaticPromptContextBudget,
  estimatePromptTokens,
} from '../../src/runtimes/context-window-budget.js';

// The reported failure (#9118) had 462,317 bytes of provider tool
// definitions on every request — a static payload that no amount of
// conversation compaction can remove.
const REPORTED_STATIC_PROMPT_BYTES = 462_317;

const BYOK_RUN = {
  agentName: 'OpenAI API via OpenCode',
  model: 'open-design-byok/deepseek-v4-pro',
  contextWindowTokens: BYOK_OPENCODE_CONTEXT_TOKEN_LIMIT,
  outputTokenReserveTokens: BYOK_OPENCODE_OUTPUT_TOKEN_LIMIT,
};

describe('estimatePromptTokens', () => {
  it('uses the daemon-wide utf8_bytes_div_3_ceil convention', () => {
    expect(estimatePromptTokens(0)).toBe(0);
    expect(estimatePromptTokens(3)).toBe(1);
    expect(estimatePromptTokens(4)).toBe(2);
    expect(estimatePromptTokens(REPORTED_STATIC_PROMPT_BYTES)).toBe(154_106);
  });
});

describe('checkStaticPromptContextBudget', () => {
  it('passes a prompt that still leaves room for the reply', () => {
    expect(
      checkStaticPromptContextBudget({
        ...BYOK_RUN,
        promptBytes: 100_000,
      }),
    ).toBeNull();
  });

  it('refuses a static prompt that alone exceeds the declared context window', () => {
    const failure = checkStaticPromptContextBudget({
      ...BYOK_RUN,
      promptBytes: REPORTED_STATIC_PROMPT_BYTES,
    });

    expect(failure).not.toBeNull();
    expect(failure).toMatchObject({
      code: 'AGENT_PROMPT_TOO_LARGE',
      promptTokenEstimate: 154_106,
      contextWindowTokens: BYOK_OPENCODE_CONTEXT_TOKEN_LIMIT,
      limit: BYOK_OPENCODE_CONTEXT_TOKEN_LIMIT - BYOK_OPENCODE_OUTPUT_TOKEN_LIMIT,
    });
  });

  it('refuses a prompt that fits the window but leaves no room for the reply', () => {
    // Exactly at the declared window: compaction would trim history to
    // reach this point, then immediately re-fire once the model answers.
    const failure = checkStaticPromptContextBudget({
      ...BYOK_RUN,
      promptBytes: BYOK_OPENCODE_CONTEXT_TOKEN_LIMIT * 3,
    });

    expect(failure).not.toBeNull();
    expect(failure?.promptTokenEstimate).toBe(BYOK_OPENCODE_CONTEXT_TOKEN_LIMIT);
  });

  it('names the agent, the model, and the fix the user can act on', () => {
    const failure = checkStaticPromptContextBudget({
      ...BYOK_RUN,
      promptBytes: REPORTED_STATIC_PROMPT_BYTES,
    });

    expect(failure?.message).toContain('OpenAI API via OpenCode');
    expect(failure?.message).toContain(BYOK_OPENCODE_CONTEXT_TOKEN_LIMIT.toLocaleString('en-US'));
    expect(failure?.message).toMatch(/compaction/i);
    expect(failure?.message).toMatch(/skills\/design-system context|new conversation/i);
  });

  it('stays silent when the window is unknown instead of inventing a failure', () => {
    for (const contextWindowTokens of [0, Number.NaN, -1]) {
      expect(
        checkStaticPromptContextBudget({
          ...BYOK_RUN,
          contextWindowTokens,
          promptBytes: REPORTED_STATIC_PROMPT_BYTES,
        }),
      ).toBeNull();
    }
  });
});
