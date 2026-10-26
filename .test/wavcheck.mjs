// Inspect a PCM WAV: header sanity, duration, RMS/peak per channel, silence
// fraction. Usage: node wavcheck.mjs <file.wav> [--json]
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node wavcheck.mjs <file.wav>');
  process.exit(2);
}
const buffer = readFileSync(file);
const riff = buffer.toString('ascii', 0, 4);
const wave = buffer.toString('ascii', 8, 12);
const fmtTag = buffer.readUInt16LE(20);
const channels = buffer.readUInt16LE(22);
const rate = buffer.readUInt32LE(24);
const byteRate = buffer.readUInt32LE(28);
const blockAlign = buffer.readUInt16LE(32);
const bits = buffer.readUInt16LE(34);
const dataTag = buffer.toString('ascii', 36, 40);
const dataSize = buffer.readUInt32LE(40);
const declaredRiff = buffer.readUInt32LE(4);

const frames = Math.floor(dataSize / blockAlign);
const samples = new Float64Array(frames * channels);
let sum = 0;
let peak = 0;
let loud = 0;
for (let frame = 0; frame < frames; frame++) {
  for (let channel = 0; channel < channels; channel++) {
    const value = buffer.readInt16LE(44 + frame * blockAlign + channel * 2) / 32768;
    samples[frame * channels + channel] = value;
    sum += value * value;
    if (Math.abs(value) > peak) peak = Math.abs(value);
  }
}
const rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
const windowFrames = Math.max(1, Math.round(rate * 0.1));
for (let start = 0; start + windowFrames <= frames; start += windowFrames) {
  let windowSum = 0;
  for (let index = start; index < start + windowFrames; index++) {
    for (let channel = 0; channel < channels; channel++) {
      const value = samples[index * channels + channel];
      windowSum += value * value;
    }
  }
  if (Math.sqrt(windowSum / (windowFrames * channels)) > 0.002) loud++;
}
const report = {
  file,
  bytes: buffer.length,
  header: { riff, wave, fmtTag, channels, rate, byteRate, blockAlign, bits, dataTag, dataSize, declaredRiff },
  headerValid:
    riff === 'RIFF' && wave === 'WAVE' && fmtTag === 1 && dataTag === 'data' &&
    bits === 16 && channels === 1 && rate === 16000 &&
    declaredRiff === buffer.length - 8 && dataSize === buffer.length - 44,
  format: `${rate}Hz ${channels}ch ${bits}bit`,
  durationSeconds: Number((frames / rate).toFixed(3)),
  frames,
  rms: Number(rms.toFixed(6)),
  rmsDb: Number((20 * Math.log10(rms || 1e-12)).toFixed(2)),
  peak: Number(peak.toFixed(6)),
  loudWindows: loud,
  verdict: rms > 0.002 ? 'non-silent' : 'silent',
};
console.log(JSON.stringify(report, null, 2));
