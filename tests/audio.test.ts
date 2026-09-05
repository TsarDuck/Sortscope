import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  PIANO_TONE_LOW_FREQUENCY,
  createSmallArrayPianoToneMap,
  decodePcmWav,
  getContinuousToneFrequency,
  getSafeScheduledAudioTime,
  isCompletionSweepAudioFinished,
  usesContinuousDenseTone,
} from "../app/lib/audio";

function createPcmWav({
  channels = 2,
  sampleRate = 48_000,
  frames = [
    [0, 0],
    [32_767, -32_768],
  ],
}: {
  channels?: number;
  sampleRate?: number;
  frames?: number[][];
}) {
  const blockAlign = channels * 2;
  const dataLength = frames.length * blockAlign;
  const bytes = new ArrayBuffer(44 + dataLength);
  const view = new DataView(bytes);
  const writeFourCc = (offset: number, value: string) => {
    [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  };

  writeFourCc(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeFourCc(8, "WAVE");
  writeFourCc(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeFourCc(36, "data");
  view.setUint32(40, dataLength, true);

  frames.forEach((frame, frameIndex) => {
    frame.forEach((sample, channel) => {
      view.setInt16(44 + frameIndex * blockAlign + channel * 2, sample, true);
    });
  });

  return bytes;
}

test("short rows assign every distinct value an ascending piano note", () => {
  const tones = createSmallArrayPianoToneMap([4, 1, 3, 2]);

  assert.ok(tones);
  const ordered = [1, 2, 3, 4].map((value) => tones.get(value) ?? 0);
  assert.equal(ordered[0], PIANO_TONE_LOW_FREQUENCY);
  assert.equal(ordered.at(-1), PIANO_TONE_LOW_FREQUENCY * 4);
  assert.ok(ordered.every((tone, index) => index === 0 || ordered[index - 1] < tone));
  assert.ok(
    ordered.every((tone) => {
      const semitones = Math.log2(tone / PIANO_TONE_LOW_FREQUENCY) * 12;
      return Math.abs(semitones - Math.round(semitones)) < 0.000_000_1;
    }),
  );
});

test("a 25-value row uses every piano semitone from C4 through C6", () => {
  const tones = createSmallArrayPianoToneMap(
    Array.from({ length: 25 }, (_, index) => 25 - index),
  );

  assert.ok(tones);
  const ordered = Array.from({ length: 25 }, (_, index) => tones.get(index + 1) ?? 0);
  assert.equal(new Set(ordered).size, 25);
  assert.equal(ordered[0], PIANO_TONE_LOW_FREQUENCY);
  assert.equal(ordered.at(-1), PIANO_TONE_LOW_FREQUENCY * 4);
});

test("short rows preserve a pitch for duplicate values and dense rows stay continuous", () => {
  const tones = createSmallArrayPianoToneMap([1, 3, 1, 2]);

  assert.ok(tones);
  assert.equal(tones.size, 3);
  assert.equal(tones.get(1), PIANO_TONE_LOW_FREQUENCY);
  assert.equal(createSmallArrayPianoToneMap(Array.from({ length: 26 }, (_, index) => index + 1)), null);

  const first = getContinuousToneFrequency(2, 256);
  const second = getContinuousToneFrequency(3, 256);
  assert.ok(first > PIANO_TONE_LOW_FREQUENCY);
  assert.ok(second > first);
  assert.notEqual(Math.log2(first / PIANO_TONE_LOW_FREQUENCY) * 12, Math.round(Math.log2(first / PIANO_TONE_LOW_FREQUENCY) * 12));
});

test("dense tone scheduling never starts in the current or a past audio quantum", () => {
  assert.equal(getSafeScheduledAudioTime(1.25, 1, 0.008), 1.25);
  assert.equal(getSafeScheduledAudioTime(0.95, 1, 0.008), 1.008);
  assert.equal(getSafeScheduledAudioTime(1, 1, 0), 1);
});

test("dense rows use one continuous tone engine while piano rows retain note voices", () => {
  assert.equal(usesContinuousDenseTone(25), false);
  assert.equal(usesContinuousDenseTone(26), true);
  assert.equal(usesContinuousDenseTone(256), true);
});

test("completion output waits for source-ended lifecycle completion", () => {
  assert.equal(isCompletionSweepAudioFinished(false, 0), false);
  assert.equal(isCompletionSweepAudioFinished(true, 2), false);
  assert.equal(isCompletionSweepAudioFinished(true, 1), false);
  assert.equal(isCompletionSweepAudioFinished(true, 0), true);
  assert.equal(isCompletionSweepAudioFinished(true, -1), true);
});

test("casino PCM WAV decoding creates normalized Web Audio channels", () => {
  const clip = decodePcmWav(createPcmWav({ sampleRate: 48_000 }));

  assert.equal(clip.numberOfChannels, 2);
  assert.equal(clip.sampleRate, 48_000);
  assert.equal(clip.frameCount, 2);
  assert.equal(clip.durationMilliseconds, 2 / 48_000 * 1_000);
  assert.equal(clip.channelData[0]?.[0], 0);
  assert.equal(clip.channelData[0]?.[1], 32_767 / 32_768);
  assert.equal(clip.channelData[1]?.[1], -1);
});

test("casino PCM WAV decoding rejects a non-WAV asset", () => {
  assert.throws(
    () => decodePcmWav(new ArrayBuffer(12)),
    /RIFF\/WAVE/,
  );
});

test("all bundled casino cues stay in the portable PCM WAV format", async () => {
  const files = [
    "bogo-casino-gambling.wav",
    "bogo-casino-shuffle.wav",
    "bogo-casino-fail.wav",
    "bogo-casino-success.wav",
  ];

  await Promise.all(files.map(async (file) => {
    const fileBytes = await readFile(join(process.cwd(), "public", "audio", file));
    const bytes = Uint8Array.from(fileBytes).buffer;
    const clip = decodePcmWav(bytes);
    assert.equal(clip.numberOfChannels, 2, file);
    assert.equal(clip.sampleRate, 48_000, file);
    assert.ok(clip.durationMilliseconds > 100, file);
  }));
});
