// Robust RIFF/WAVE probe: walks the chunk list (JUNK/LIST/fmt/data), decodes
// 8/16/24/32-bit PCM (also float32), reports duration + windowed RMS profile.
// Usage: node wavprobe.mjs <file.wav> [--windows N]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args[0];
const wi = args.indexOf("--windows");
const windowCount = wi >= 0 ? Number(args[wi + 1]) || 20 : 20;

const buf = readFileSync(file);
if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
  console.log(JSON.stringify({ file, error: "not RIFF/WAVE" }));
  process.exit(2);
}

const chunks = [];
let off = 12;
while (off + 8 <= buf.length) {
  const id = buf.toString("ascii", off, off + 4);
  const size = buf.readUInt32LE(off + 4);
  chunks.push({ id, size, bodyOffset: off + 8 });
  off += 8 + size + (size % 2);
}

const fmtChunk = chunks.find((c) => c.id === "fmt ");
const dataChunk = chunks.find((c) => c.id === "data");
if (!fmtChunk || !dataChunk) {
  console.log(JSON.stringify({ file, error: "missing fmt/data", chunks: chunks.map((c) => c.id) }));
  process.exit(2);
}

const audioFormat = buf.readUInt16LE(fmtChunk.bodyOffset);
const channels = buf.readUInt16LE(fmtChunk.bodyOffset + 2);
const sampleRate = buf.readUInt32LE(fmtChunk.bodyOffset + 4);
const bits = buf.readUInt16LE(fmtChunk.bodyOffset + 14);
const bytesPerSample = bits / 8;
const frameBytes = bytesPerSample * channels;
const dataBytes = Math.min(dataChunk.size, buf.length - dataChunk.bodyOffset);
const frames = Math.floor(dataBytes / frameBytes);
const durationSeconds = frames / sampleRate;

function sampleAt(byteOffset) {
  if (audioFormat === 3) return buf.readFloatLE(byteOffset);
  if (bits === 8) return (buf.readUInt8(byteOffset) - 128) / 128;
  if (bits === 16) return buf.readInt16LE(byteOffset) / 32768;
  if (bits === 24) {
    const v = buf.readUInt8(byteOffset) | (buf.readUInt8(byteOffset + 1) << 8) | (buf.readUInt8(byteOffset + 2) << 16);
    return (v & 0x800000 ? v - 0x1000000 : v) / 8388608;
  }
  if (bits === 32) return buf.readInt32LE(byteOffset) / 2147483648;
  return 0;
}

const windows = new Array(windowCount).fill(0);
const counts = new Array(windowCount).fill(0);
let peak = 0;
let sumSq = 0;
let nonZero = 0;
for (let f = 0; f < frames; f++) {
  const base = dataChunk.bodyOffset + f * frameBytes;
  let mono = 0;
  for (let c = 0; c < channels; c++) mono += sampleAt(base + c * bytesPerSample);
  mono /= channels;
  const a = Math.abs(mono);
  if (a > peak) peak = a;
  if (a > 1e-4) nonZero++;
  sumSq += mono * mono;
  const w = Math.min(windowCount - 1, Math.floor((f / frames) * windowCount));
  windows[w] += mono * mono;
  counts[w]++;
}
const rms = Math.sqrt(sumSq / Math.max(1, frames));
const windowRms = windows.map((s, i) => Number(Math.sqrt(s / Math.max(1, counts[i])).toFixed(5)));
const text = chunks
  .filter((c) => c.id !== "fmt " && c.id !== "data")
  .map((c) => ({ id: c.id, size: c.size, ascii: buf.toString("ascii", c.bodyOffset, Math.min(c.bodyOffset + 120, c.bodyOffset + c.size)).replace(/[^\x20-\x7e]/g, ".").trim() }));

console.log(JSON.stringify({
  file,
  format: `${sampleRate}Hz ${channels}ch ${bits}bit ${audioFormat === 3 ? "float" : "pcm"}`,
  chunks: chunks.map((c) => c.id),
  extraChunks: text,
  frames, durationSeconds: Number(durationSeconds.toFixed(3)),
  rms: Number(rms.toFixed(6)),
  rmsDb: Number((20 * Math.log10(rms || 1e-9)).toFixed(2)),
  peak: Number(peak.toFixed(6)),
  frameActiveRatio: Number((nonZero / Math.max(1, frames)).toFixed(3)),
  windowRms,
}, null, 2));
