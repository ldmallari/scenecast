// The one voice track the mix takes: every scene's voice clip placed at the time its scene starts
// in the final video, silence everywhere else (cards, breaths, dissolves).
import fs from 'node:fs';

export interface Pcm {
  sampleRate: number;
  samples: Int16Array;
}

/** Reads a 16-bit mono PCM WAV (what the voice stage writes). */
export function readWav(file: string): Pcm {
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') throw new Error(`${file}: not a WAV file`);
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  for (let o = 12; o + 8 <= b.length; ) {
    const id = b.toString('latin1', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error(`${file}: data before fmt`);
      if (fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16)
        throw new Error(`${file}: expected 16-bit mono PCM, got format ${fmt.format}, ${fmt.channels} ch, ${fmt.bits} bit`);
      const len = Math.min(size, b.length - body);
      const samples = new Int16Array(len >> 1);
      for (let i = 0; i < samples.length; i++) samples[i] = b.readInt16LE(body + 2 * i);
      return { sampleRate: fmt.rate, samples };
    }
    o = body + size + (size & 1);
  }
  throw new Error(`${file}: no data chunk`);
}

export function writeWav(file: string, pcm: Pcm): void {
  const data = pcm.samples.length * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(pcm.sampleRate, 24);
  b.writeUInt32LE(pcm.sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(data, 40);
  for (let i = 0; i < pcm.samples.length; i++) b.writeInt16LE(pcm.samples[i]!, 44 + 2 * i);
  fs.writeFileSync(file, b);
}

/**
 * Writes one WAV of `total` seconds with each clip starting at its `start` (seconds). Clips must share
 * a sample rate and fit inside the track (a scene's voice always ends before the scene does).
 */
export function buildVoiceTrack(clips: { file: string; start: number }[], total: number, out: string): void {
  const read = clips.map((c) => ({ ...c, pcm: readWav(c.file) }));
  const rate = read[0]?.pcm.sampleRate ?? 24000;
  const samples = new Int16Array(Math.round(total * rate));
  for (const c of read) {
    if (c.pcm.sampleRate !== rate) throw new Error(`voice clips disagree on the sample rate (${c.file})`);
    const at = Math.round(c.start * rate);
    if (at < 0 || at + c.pcm.samples.length > samples.length)
      throw new Error(`voice clip ${c.file} (${(c.pcm.samples.length / rate).toFixed(2)} s at ${c.start.toFixed(2)} s) runs past the ${total.toFixed(2)} s track`);
    samples.set(c.pcm.samples, at);
  }
  writeWav(out, { sampleRate: rate, samples });
}
