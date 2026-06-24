export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TurnDetectionConfig {
  type: 'server_vad' | 'semantic_vad';
  threshold?: number;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;
  eagerness?: 'low' | 'medium' | 'high';
  create_response?: boolean;
  interrupt_response?: boolean;
}

export interface RealtimeSessionConfig {
  type?: string;
  modalities?: ('text' | 'audio')[];
  instructions: string;
  voice?: string;
  input_audio_format?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  output_audio_format?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  input_audio_transcription?: { model: string } | null;
  turn_detection?: TurnDetectionConfig | null;
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required';
  temperature?: number;
  max_response_output_tokens?: number | 'inf';
}

// ─── Server → Client events ───────────────────────────────────────────────────

export type RealtimeEvent =
  | { type: 'session.created'; session: { id: string } }
  | { type: 'session.updated'; session: { id: string } }
  | { type: 'input_audio_buffer.speech_started' }
  | { type: 'input_audio_buffer.speech_stopped' }
  | { type: 'response.created'; response: { id: string } }
  | { type: 'response.done'; response: { id: string; status: string } }
  | { type: 'response.audio.delta'; response_id: string; item_id: string; delta: string }
  | { type: 'response.audio.done'; response_id: string; item_id: string }
  | { type: 'response.text.delta'; response_id: string; item_id: string; delta: string }
  | { type: 'response.text.done'; response_id: string; item_id: string; text: string }
  | {
      type: 'response.function_call_arguments.done';
      response_id: string;
      item_id: string;
      call_id: string;
      name: string;
      arguments: string;
    }
  | { type: 'conversation.item.created'; item: Record<string, unknown> }
  | { type: 'error'; error: { type: string; code: string; message: string } };
