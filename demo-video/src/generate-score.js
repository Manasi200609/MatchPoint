import fs from 'node:fs';
import path from 'node:path';

// A quiet, original ambient score made from oscillators, slow swells, and soft transition chimes.
// This is a creative sound bed, not a recording or a product/system sound.
const out = path.resolve(import.meta.dirname, '../assets/score.wav');
const sampleRate = 22050;
const seconds = 240;
const frames = sampleRate * seconds;
const dataBytes = frames * 4;
const buffer = Buffer.alloc(44 + dataBytes);
buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write('WAVE', 8);
buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(2, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 4, 28);
buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(dataBytes, 40);

const notes = [55, 82.41, 110, 146.83, 164.81, 220, 293.66];
let pointer = 44;
for (let i = 0; i < frames; i++) {
  const t = i / sampleRate;
  const swell = 0.58 + 0.14 * Math.sin((2 * Math.PI * t) / 44) + 0.08 * Math.sin((2 * Math.PI * t) / 19);
  const fadeIn = Math.min(1, t / 3);
  const fadeOut = Math.min(1, (seconds - t) / 4);
  const transition = t % 15;
  const chimeEnvelope = transition < 2.2 ? Math.exp(-transition * 2.0) : 0;
  const chime = chimeEnvelope * (Math.sin(2 * Math.PI * 659.25 * t) + 0.38 * Math.sin(2 * Math.PI * 987.77 * t));
  let sample = 0;
  for (let n = 0; n < notes.length; n++) {
    const phase = 2 * Math.PI * notes[n] * t;
    const drift = 0.83 + 0.17 * Math.sin((2 * Math.PI * t) / (7.3 + n * 0.6) + n);
    sample += Math.sin(phase) * drift * (n < 2 ? 0.15 : 0.075);
    sample += Math.sin(phase * 2) * drift * (n < 2 ? 0.035 : 0.022);
  }
  sample = (sample * swell + chime * 0.085) * fadeIn * fadeOut * 0.28;
  const left = Math.max(-1, Math.min(1, sample * 0.97));
  const right = Math.max(-1, Math.min(1, sample * (0.94 + 0.03 * Math.sin(t * 0.31))));
  buffer.writeInt16LE(Math.round(left * 32767), pointer); pointer += 2;
  buffer.writeInt16LE(Math.round(right * 32767), pointer); pointer += 2;
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buffer);
console.log(`Wrote ${seconds}s ambient score: ${out}`);
