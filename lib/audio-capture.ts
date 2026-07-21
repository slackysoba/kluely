const WORKLET_URL = "/audio-processor.js";
const WORKLET_NAME = "audio-processor";

export type AudioChunkCallback = (chunk: ArrayBuffer) => void;

/** Thrown when the user denies (or the browser blocks) microphone access. */
export class MicrophonePermissionError extends Error {
  constructor() {
    super("Microphone access was denied");
    this.name = "MicrophonePermissionError";
  }
}

/**
 * Captures microphone audio through an AudioWorklet and emits 50ms chunks
 * of 16kHz mono 16-bit PCM as ArrayBuffers.
 *
 * ```ts
 * const capture = new AudioCapture();
 * await capture.start((chunk) => socket.send(chunk));
 * // ...
 * await capture.stop();
 * ```
 */
export class AudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;

  get isCapturing(): boolean {
    return this.context !== null;
  }

  async start(onChunk: AudioChunkCallback): Promise<void> {
    if (this.context) {
      throw new Error("AudioCapture is already running; call stop() first");
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (err) {
      if (
        err instanceof DOMException &&
        (err.name === "NotAllowedError" || err.name === "SecurityError")
      ) {
        throw new MicrophonePermissionError();
      }
      throw err;
    }

    try {
      this.context = new AudioContext();
      if (this.context.state === "suspended") {
        await this.context.resume();
      }
      await this.context.audioWorklet.addModule(WORKLET_URL);

      this.source = this.context.createMediaStreamSource(this.stream);
      this.workletNode = new AudioWorkletNode(this.context, WORKLET_NAME);
      this.workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        onChunk(event.data);
      };
      this.source.connect(this.workletNode);
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.port.close();
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    if (this.context) {
      const context = this.context;
      this.context = null;
      if (context.state !== "closed") {
        await context.close();
      }
    }
  }
}
