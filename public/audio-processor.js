const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 800; // 50ms at 16kHz

/**
 * Downmixes to mono, resamples from the AudioContext's native rate
 * (the `sampleRate` global) to 16kHz via linear interpolation, converts
 * to 16-bit signed PCM, and posts one ArrayBuffer per 50ms chunk.
 */
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_SAMPLE_RATE;
    // Fractional read index into the current input block. -1 refers to the
    // last sample of the previous block, so interpolation stays continuous
    // across the 128-frame render quanta.
    this.pos = 0;
    this.prevSample = 0;
    this.chunk = new Int16Array(CHUNK_SAMPLES);
    this.chunkIndex = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || channels[0].length === 0) {
      return true;
    }

    const frames = channels[0].length;
    let mono = channels[0];
    if (channels.length > 1) {
      mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels.length; c++) {
          sum += channels[c][i];
        }
        mono[i] = sum / channels.length;
      }
    }

    let pos = this.pos;
    while (pos < frames - 1) {
      let sample;
      if (pos < 0) {
        const t = pos + 1;
        sample = this.prevSample + (mono[0] - this.prevSample) * t;
      } else {
        const i = Math.floor(pos);
        const t = pos - i;
        sample = mono[i] + (mono[i + 1] - mono[i]) * t;
      }
      this.pushSample(sample);
      pos += this.ratio;
    }
    this.pos = pos - frames;
    this.prevSample = mono[frames - 1];

    return true;
  }

  pushSample(sample) {
    const s = Math.max(-1, Math.min(1, sample));
    this.chunk[this.chunkIndex++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.chunkIndex === CHUNK_SAMPLES) {
      this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
      this.chunk = new Int16Array(CHUNK_SAMPLES);
      this.chunkIndex = 0;
    }
  }
}

registerProcessor('audio-processor', AudioProcessor);
