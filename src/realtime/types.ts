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
  // gpt-4o-realtime-preview events
  | { type: 'response.audio.delta'; response_id: string; item_id: string; delta: string }
  | { type: 'response.audio.done'; response_id: string; item_id: string }
  | { type: 'response.text.delta'; response_id: string; item_id: string; delta: string }
  | { type: 'response.text.done'; response_id: string; item_id: string; text: string }
  // gpt-realtime-* events (new schema)
  | { type: 'response.output_audio.delta'; delta: string }
  | { type: 'response.output_audio.done' }
  | { type: 'response.output_audio_transcript.delta'; delta: string }
  | { type: 'response.output_audio_transcript.done'; transcript: string }
  // Transcrição do usuário
  | { type: 'conversation.item.input_audio_transcription.completed'; transcript: string }
  | { type: 'input_audio_buffer.transcript'; transcript: string }
  | {
      type: 'response.function_call_arguments.done';
      response_id: string;
      item_id: string;
      call_id: string;
      name: string;
      arguments: string;
    }
  | { type: 'conversation.item.created'; item: { role?: string; type?: string; content?: { type?: string; transcript?: string; text?: string }[] } }
  | { type: 'error'; error: { type: string; code: string; message: string } };
