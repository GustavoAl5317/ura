// Cliente mínimo da OpenAI Chat Completions API (function calling) via axios.
// Segue o padrão do projeto: sem SDK, só HTTP.

import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../config';
import { logger } from '../logger';

export interface ChatToolFunction {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export interface ChatCompletionResult {
  content: string | null;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
}

let http: AxiosInstance | null = null;
function client(): AxiosInstance {
  if (!http) {
    http = axios.create({
      baseURL: 'https://api.openai.com/v1',
      timeout: 60_000,
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }
  return http;
}

/** Uma chamada à Chat Completions. Retorna texto e/ou tool_calls. */
export async function chatCompletion(
  messages: ChatMessage[],
  tools: ChatToolFunction[],
): Promise<ChatCompletionResult> {
  const body = {
    model: config.chat.model,
    temperature: config.chat.temperature,
    max_tokens: config.chat.maxTokens,
    messages,
    tools,
    tool_choice: 'auto' as const,
  };

  try {
    const res = await client().post('/chat/completions', body);
    const choice = res.data?.choices?.[0];
    const msg = choice?.message ?? {};
    return {
      content: typeof msg.content === 'string' ? msg.content : null,
      toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
      finishReason: choice?.finish_reason ?? null,
    };
  } catch (err: unknown) {
    const ax = err as AxiosError;
    logger.error('OpenAI chat erro', {
      status: ax.response?.status,
      body: JSON.stringify(ax.response?.data ?? '').slice(0, 500),
      err: ax.message,
    });
    throw err;
  }
}
