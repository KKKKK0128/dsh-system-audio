// Generate a deterministic PCM WAV test signal so loopback capture can be
// verified independently of any TTS engine. Usage:
//   node tone.mjs <out.wav> [seconds] [rate] [channels]
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
const seconds = Number(process.argv[3] ?? 3);
const rate = Number(process.argv[4] ?? 44100);
const channels = Number(process.argv[5] ?? 2);
if (!out) {
  console.error('usage: node tone.mjs <out.wav> [seconds] [rate] [channels]');
  process.exit(2);
}

const frames = Math.round(seconds * rate);
const bits = 16;
const blockAlign = channels * bits / 8;
const dataBytes = frames * blockAlign;
const buffer = Buffer.alloc(44 + dataBytes);

buffer.write('RIFF', 0, 'ascii');
buffer.writeUInt32LE(36 + dataBytes, 4);
buffer.write('WAVE', 8, 'ascii');
buffer.write('fmt ', 12, 'ascii');
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(channels, 22);
buffer.writeUInt32LE(rate, 24);
buffer.writeUInt32LE(rate * blockAlign, 28);
buffer.writeUInt16LE(blockAlign, 32);
buffer.writeUInt16LE(bits, 34);
buffer.write('data', 36, 'ascii');
buffer.writeUInt32LE(dataBytes, 40);

const fade = Math.round(rate * 0.05);
for (let frame = 0; frame < frames; frame++) {
  const t = frame / rate;
  const envelope = Math.min(1, frame / fade, (frames - frame) / fade);
  // two tones, amplitude 0.35 — loud enough to be unmistakable in the capture
  const sample = 0.35 * envelope * (Math.sin(2 * Math.PI * 440 * t) + 0.5 * Math.sin(2 * Math.PI * 1320 * t));
  const value = Math.max(-1, Math.min(1, sample)) * 32767;
  for (let channel = 0; channel < channels; channel++) {
    buffer.writeInt16LE(Math.round(value), 44 + frame * blockAlign + channel * 2);
  }
}

writeFileSync(out, buffer);
console.log(JSON.stringify({ out, seconds, rate, channels, frames, bytes: buffer.length }));
