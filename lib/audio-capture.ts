const WORKLET_URL = "/audio-processor.js";
const WORKLET_NAME = "audio-processor";

export type AudioChunkCallback = (chunk: ArrayBuffer) => void;

export type CaptureSource = "microphone" | "tab";

/** Thrown when the user denies (or the browser blocks) microphone access. */
export class MicrophonePermissionError extends Error {
  constructor() {
    super("Microphone access was denied");
    this.name = "MicrophonePermissionError";
  }
}

/** Thrown when the browser has no usable getDisplayMedia audio capture. */
export class DisplayCaptureUnsupportedError extends Error {
  constructor() {
    super("This browser cannot capture tab audio");
    this.name = "DisplayCaptureUnsupportedError";
  }
}

/** Thrown when the user dismisses the share picker. Not really an error. */
export class CaptureCancelledError extends Error {
  constructor() {
    super("The user cancelled the share picker");
    this.name = "CaptureCancelledError";
  }
}

/** Thrown when a tab was shared without ticking "Also share tab audio". */
export class TabAudioUnavailableError extends Error {
  constructor() {
    super("The shared tab has no audio track");
    this.name = "TabAudioUnavailableError";
  }
}

export interface CaptureOptions {
  /** Where the audio comes from. Defaults to the microphone. */
  source?: CaptureSource;
  /**
   * Fired when the source track ends outside our control — Chrome's
   * "Stop sharing" bar in tab mode, or an unplugged device in mic mode.
   */
  onSourceEnded?: () => void;
}

/**
 * Captures audio through an AudioWorklet and emits 50ms chunks of 16kHz
 * mono 16-bit PCM as ArrayBuffers. The worklet downmixes whatever channel
 * layout the source has (tab audio is typically 48kHz stereo) to mono
 * before resampling, so both sources share one pipeline.
 *
 * ```ts
 * const capture = new AudioCapture();
 * await capture.start((chunk) => socket.send(chunk), { source: "tab" });
 * // ...
 * await capture.stop();
 * ```
 */
export class AudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private onSourceEnded: (() => void) | null = null;

  get isCapturing(): boolean {
    return this.context !== null;
  }

  async start(
    onChunk: AudioChunkCallback,
    options: CaptureOptions = {}
  ): Promise<void> {
    if (this.context) {
      throw new Error("AudioCapture is already running; call stop() first");
    }

    const source = options.source ?? "microphone";
    this.stream =
      source === "tab"
        ? await this.acquireTabAudio()
        : await this.acquireMicrophone();

    this.onSourceEnded = options.onSourceEnded ?? null;
    for (const track of this.stream.getAudioTracks()) {
      track.addEventListener("ended", this.handleTrackEnded);
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
    // Detach the ended callback first so our own teardown never loops
    // back into the caller.
    this.onSourceEnded = null;
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
        track.removeEventListener("ended", this.handleTrackEnded);
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

  private readonly handleTrackEnded = (): void => {
    this.onSourceEnded?.();
  };

  private async acquireMicrophone(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({
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
  }

  private async acquireTabAudio(): Promise<MediaStream> {
    if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
      throw new DisplayCaptureUnsupportedError();
    }

    let display: MediaStream;
    try {
      // Chrome only offers the "Also share tab audio" checkbox when video
      // is requested too; we discard the video track immediately below.
      display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
    } catch (err) {
      if (
        err instanceof DOMException &&
        (err.name === "NotAllowedError" || err.name === "AbortError")
      ) {
        throw new CaptureCancelledError();
      }
      throw err;
    }

    for (const track of display.getVideoTracks()) {
      track.stop();
    }

    const audioTracks = display.getAudioTracks();
    if (audioTracks.length === 0) {
      // Shared a window/screen, or a tab without ticking the audio box.
      for (const track of display.getTracks()) {
        track.stop();
      }
      throw new TabAudioUnavailableError();
    }

    return new MediaStream(audioTracks);
  }
}
