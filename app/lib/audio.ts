/**
 * The visualizer uses a practical continuous frequency ramp for dense rows,
 * but a short row can give every distinct value a real 12-tone piano pitch.
 * Keeping the mapping here makes live steps and the completion scan agree.
 */
export const PIANO_TONE_MIN_ARRAY_SIZE = 4;
export const PIANO_TONE_MAX_ARRAY_SIZE = 25;
export const PIANO_TONE_LOW_FREQUENCY = 261.6255653005986; // C4
export const PIANO_TONE_SEMITONE_SPAN = 24; // C4 through C6

/**
 * Short rows are intentionally articulated as individual piano notes. Above
 * that range, one reusable oscillator is gated into discrete pulses, avoiding
 * per-event source churn in WebKit while retaining silence between sounds.
 */
export function usesContinuousDenseTone(valueCount: number) {
  return valueCount > PIANO_TONE_MAX_ARRAY_SIZE;
}

/**
 * A completion output is safe to detach only after scheduling is finished and
 * every one-shot voice has reported `ended`. This deliberately uses the audio
 * graph's lifecycle rather than wall-clock time: AudioContext.currentTime can
 * pause while a desktop webview is interrupted or its audio route changes.
 */
export function isCompletionSweepAudioFinished(
  schedulingComplete: boolean,
  pendingVoiceCount: number,
) {
  return schedulingComplete && pendingVoiceCount <= 0;
}

/**
 * The casino clips are small, uncompressed PCM WAV files. Parsing that tiny
 * format ourselves lets the app send their samples through the same Web Audio
 * output that already drives Sortscope's synthesized notes. In particular it
 * avoids WebKitGTK's separate HTML media/GStreamer pipeline in Linux AppImage
 * builds, where local media elements can fail even though AudioContext output
 * is healthy.
 */
export type DecodedPcmWav = {
  channelData: Float32Array<ArrayBuffer>[];
  numberOfChannels: number;
  sampleRate: number;
  frameCount: number;
  durationMilliseconds: number;
};

function readFourCc(view: DataView, offset: number) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Decode a standard little-endian, 16-bit PCM WAV into Web Audio-ready float
 * channels. We deliberately reject other codecs instead of producing a
 * partially decoded cue: the bundled clips are validated PCM assets, and a
 * clear failure can safely fall back to the lesson's timed visual state.
 */
export function decodePcmWav(bytes: ArrayBuffer): DecodedPcmWav {
  const view = new DataView(bytes);
  if (view.byteLength < 12 || readFourCc(view, 0) !== "RIFF" || readFourCc(view, 8) !== "WAVE") {
    throw new Error("Expected a RIFF/WAVE audio file.");
  }

  let format: number | null = null;
  let numberOfChannels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let blockAlign: number | null = null;
  let dataOffset: number | null = null;
  let dataLength: number | null = null;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkName = readFourCc(view, offset);
    const chunkLength = view.getUint32(offset + 4, true);
    const chunkOffset = offset + 8;
    const chunkEnd = chunkOffset + chunkLength;

    if (chunkEnd > view.byteLength) {
      throw new Error("WAV chunk extends beyond the available audio data.");
    }

    if (chunkName === "fmt ") {
      if (chunkLength < 16) throw new Error("WAV format chunk is incomplete.");
      format = view.getUint16(chunkOffset, true);
      numberOfChannels = view.getUint16(chunkOffset + 2, true);
      sampleRate = view.getUint32(chunkOffset + 4, true);
      blockAlign = view.getUint16(chunkOffset + 12, true);
      bitsPerSample = view.getUint16(chunkOffset + 14, true);
    } else if (chunkName === "data") {
      dataOffset = chunkOffset;
      dataLength = chunkLength;
      break;
    }

    // RIFF chunks are padded to an even boundary.
    offset = chunkEnd + (chunkLength % 2);
  }

  if (
    format !== 1 ||
    !numberOfChannels ||
    !sampleRate ||
    bitsPerSample !== 16 ||
    !blockAlign ||
    dataOffset === null ||
    dataLength === null
  ) {
    throw new Error("Casino audio must be 16-bit PCM WAV.");
  }

  const expectedBlockAlign = numberOfChannels * 2;
  if (blockAlign !== expectedBlockAlign || dataLength % blockAlign !== 0) {
    throw new Error("WAV sample frames are not aligned correctly.");
  }

  const frameCount = dataLength / blockAlign;
  const channelData: Float32Array<ArrayBuffer>[] = Array.from(
    { length: numberOfChannels },
    () => new Float32Array(frameCount),
  );

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameOffset = dataOffset + frame * blockAlign;
    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      channelData[channel]![frame] = view.getInt16(frameOffset + channel * 2, true) / 32_768;
    }
  }

  return {
    channelData,
    numberOfChannels,
    sampleRate,
    frameCount,
    durationMilliseconds: (frameCount / sampleRate) * 1_000,
  };
}

export function getContinuousToneFrequency(value: number, largestValue: number) {
  const normalizedValue = Math.min(
    1,
    Math.max(0, (value - 1) / Math.max(largestValue - 1, 1)),
  );
  const compressedValue = Math.sqrt(normalizedValue);

  // Keep the C4-to-C6-ish range for dense rows, but interpolate rather than
  // quantizing so neighboring values retain their individual positions.
  return PIANO_TONE_LOW_FREQUENCY * 2 ** ((compressedValue * PIANO_TONE_SEMITONE_SPAN) / 12);
}

/**
 * Web Audio automation scheduled at or before the current render quantum can
 * begin with an unresolved gain value after a busy frame. Keep dense visual
 * tones a few milliseconds ahead of the audio clock so their fade-in is
 * always applied before the oscillator becomes audible.
 */
export function getSafeScheduledAudioTime(
  requestedTime: number,
  currentTime: number,
  minimumLeadSeconds: number,
) {
  return Math.max(requestedTime, currentTime + Math.max(0, minimumLeadSeconds));
}

export type DenseTonePulseWindow = {
  startTime: number;
  attackEndTime: number;
  releaseStartTime: number;
  endTime: number;
};

/**
 * Build one non-overlapping dense-tone pulse, or coalesce a checkpoint that
 * arrives before the preceding pulse has had an audible silence gap. Keeping
 * this decision on the AudioContext timeline makes the cadence independent of
 * delayed/coalesced WebKit rendering while bounding AudioParam automation.
 */
export function getDenseTonePulseWindow(
  lastPulseEndTime: number | null,
  requestedStartTime: number,
  attackSeconds: number,
  holdSeconds: number,
  releaseSeconds: number,
  minimumSilenceSeconds: number,
): DenseTonePulseWindow | null {
  const minimumNextStart =
    lastPulseEndTime === null
      ? Number.NEGATIVE_INFINITY
      : lastPulseEndTime + Math.max(0, minimumSilenceSeconds);
  if (requestedStartTime < minimumNextStart) return null;

  const startTime = requestedStartTime;
  const attackEndTime = startTime + Math.max(0, attackSeconds);
  const releaseStartTime = attackEndTime + Math.max(0, holdSeconds);
  const endTime = releaseStartTime + Math.max(0, releaseSeconds);
  return { startTime, attackEndTime, releaseStartTime, endTime };
}

/**
 * Return a distinct, ascending piano pitch for each distinct value in a
 * short row. Values are ranked numerically instead of assumed to be 1..N, so
 * the same helper still behaves predictably for a custom input in the future.
 */
export function createSmallArrayPianoToneMap(values: readonly number[]) {
  if (values.length < PIANO_TONE_MIN_ARRAY_SIZE || values.length > PIANO_TONE_MAX_ARRAY_SIZE) {
    return null;
  }

  const sortedUniqueValues = [...new Set(values)].sort((left, right) => left - right);
  if (sortedUniqueValues.length === 0) return null;

  const lastIndex = Math.max(sortedUniqueValues.length - 1, 1);
  return new Map(
    sortedUniqueValues.map((value, index) => {
      // Integer semitones make every short-array tone a standard equal-
      // temperament piano note. With 25 unique values this is C4..C6 exactly.
      const semitones = Math.round((index * PIANO_TONE_SEMITONE_SPAN) / lastIndex);
      const frequency = PIANO_TONE_LOW_FREQUENCY * 2 ** (semitones / 12);
      return [value, frequency] as const;
    }),
  );
}
