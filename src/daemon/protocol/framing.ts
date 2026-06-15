const MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16MB

export function encodeFrame(message: object): Buffer {
  const json = JSON.stringify(message);
  const payload = Buffer.from(json, 'utf-8');
  const length = payload.length;
  const frame = Buffer.alloc(4 + length);
  frame.writeUInt32BE(length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(data: Buffer): object[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const messages: object[] = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);

      if (length > MAX_FRAME_SIZE) {
        throw new Error(`Frame size ${length} exceeds maximum ${MAX_FRAME_SIZE}`);
      }

      if (this.buffer.length < 4 + length) break;

      const payload = this.buffer.subarray(4, 4 + length);
      const json = payload.toString('utf-8');

      try {
        messages.push(JSON.parse(json));
      } catch (e) {
        // Skip malformed frame, continue processing
        console.error('Invalid JSON in frame:', (e as Error).message);
      }

      this.buffer = this.buffer.subarray(4 + length);
    }

    return messages;
  }
}
