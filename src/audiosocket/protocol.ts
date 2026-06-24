// AudioSocket protocol implementation
// Spec: https://github.com/CyCoreSystems/audiosocket
// Each message: 1 byte type + 2 bytes length (big-endian) + N bytes payload
// Audio format: PCM signed 16-bit little-endian, 8kHz, mono (slin)

export const AUDIOSOCKET_TYPE = {
  HANGUP: 0x00,
  UUID:   0x01,
  AUDIO:  0x10,
  DTMF:   0x11,
  ERROR:  0xff,
} as const;

export type MsgType = typeof AUDIOSOCKET_TYPE[keyof typeof AUDIOSOCKET_TYPE];

export interface AudioSocketMessage {
  type: MsgType;
  payload: Buffer;
}

export class AudioSocketProtocol {
  private buf = Buffer.alloc(0);

  feed(data: Buffer): AudioSocketMessage[] {
    this.buf = Buffer.concat([this.buf, data]);
    const out: AudioSocketMessage[] = [];

    while (this.buf.length >= 3) {
      const type = this.buf[0] as MsgType;
      const length = this.buf.readUInt16BE(1);
      if (this.buf.length < 3 + length) break;

      out.push({ type, payload: Buffer.from(this.buf.subarray(3, 3 + length)) });
      this.buf = this.buf.subarray(3 + length);
    }

    return out;
  }

  static frame(type: MsgType, payload: Buffer = Buffer.alloc(0)): Buffer {
    const hdr = Buffer.allocUnsafe(3);
    hdr[0] = type;
    hdr.writeUInt16BE(payload.length, 1);
    return Buffer.concat([hdr, payload]);
  }

  static hangup(): Buffer {
    return AudioSocketProtocol.frame(AUDIOSOCKET_TYPE.HANGUP);
  }

  static audio(pcm: Buffer): Buffer {
    return AudioSocketProtocol.frame(AUDIOSOCKET_TYPE.AUDIO, pcm);
  }
}
