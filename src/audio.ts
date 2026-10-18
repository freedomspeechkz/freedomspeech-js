/**
 * Помощники для звука: PCM16 <-> WAV, нарезка на кадры, base64. / Audio helpers.
 *
 * Форматы по документации API:
 *   выход синтеза: PCM16, моно, 24 000 Гц (HTTP отдаёт WAV, WebSocket отдаёт сырой PCM);
 *   вход потокового распознавания: PCM16 little-endian, моно, 16 000 Гц, без контейнера.
 */

export const TTS_SAMPLE_RATE = 24000;
export const ASR_SAMPLE_RATE = 16000;

export type BinaryInput = ArrayBuffer | ArrayBufferView;

/** Любой бинарный вход в Uint8Array без копии, где возможно. / Normalize binary input. */
export function toBytes(data: BinaryInput): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

/** Обернуть сырой PCM16 в WAV (44-байтный RIFF-заголовок). / Wrap raw PCM16 into a WAV file. */
export function pcm16ToWav(pcm: BinaryInput, sampleRate: number = TTS_SAMPLE_RATE, channels = 1): Uint8Array {
  const bytes = toBytes(pcm);
  const out = new Uint8Array(44 + bytes.byteLength);
  const view = new DataView(out.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  const byteRate = sampleRate * channels * 2;
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + bytes.byteLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, bytes.byteLength, true);
  out.set(bytes, 44);
  return out;
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Сэмплы без заголовка. / Raw samples without the header. */
  data: Uint8Array;
}

/** Разобрать WAV: найти чанки `fmt ` и `data`. / Parse a WAV file. */
export function parseWav(wav: BinaryInput): WavInfo {
  const bytes = toBytes(wav);
  if (!isWav(bytes)) throw new Error("not a WAV file (no RIFF/WAVE header)");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number; format: number } | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    if (id === "fmt ") {
      fmt = {
        format: view.getUint16(bodyStart, true),
        channels: view.getUint16(bodyStart + 2, true),
        sampleRate: view.getUint32(bodyStart + 4, true),
        bitsPerSample: view.getUint16(bodyStart + 14, true),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data chunk before fmt chunk");
      const end = Math.min(bodyStart + size, bytes.byteLength);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, data: bytes.subarray(bodyStart, end) };
    }
    offset = bodyStart + size + (size % 2);
  }
  throw new Error("WAV data chunk not found");
}

/**
 * Достать PCM16 из WAV. / Extract PCM16 samples from a WAV file.
 *
 * Требует 16-битный моно WAV с частотой `expectRate` (по умолчанию 16 кГц, как ждёт `/ws/asr`).
 * Сервер не пересэмплирует, поэтому другой формат отклоняется, а не пропускается молча.
 * Конвертация: `ffmpeg -i in.mp3 -ar 16000 -ac 1 -f s16le out.pcm`.
 */
export function wavToPcm16(wav: BinaryInput, expectRate: number | 0 = ASR_SAMPLE_RATE): Uint8Array {
  const info = parseWav(wav);
  if (info.bitsPerSample !== 16) throw new Error(`WAV must be 16-bit PCM, got ${info.bitsPerSample} bits per sample`);
  if (info.channels !== 1) throw new Error(`WAV must be mono, got ${info.channels} channels`);
  if (expectRate && info.sampleRate !== expectRate) throw new Error(`WAV must be ${expectRate} Hz, got ${info.sampleRate} Hz`);
  return info.data;
}

/** Длительность WAV в секундах. / WAV duration in seconds. */
export function wavDuration(wav: BinaryInput): number {
  const info = parseWav(wav);
  return info.data.byteLength / (info.sampleRate * info.channels * (info.bitsPerSample / 8));
}

/** Длительность сырого PCM16 в секундах. / Raw PCM16 duration in seconds. */
export function pcm16Duration(pcm: BinaryInput, sampleRate: number = ASR_SAMPLE_RATE, channels = 1): number {
  return toBytes(pcm).byteLength / (2 * channels * sampleRate);
}

/**
 * Нарезать PCM16 на кадры по `frameMs` мс (по умолчанию 100 мс = 3200 байт при 16 кГц).
 * Каждый кадр содержит целое число сэмплов, как требует `/ws/asr`.
 */
export function* pcm16Frames(pcm: BinaryInput, frameMs = 100, sampleRate: number = ASR_SAMPLE_RATE): Generator<Uint8Array> {
  const bytes = toBytes(pcm);
  const step = Math.floor((sampleRate * frameMs) / 1000) * 2;
  if (step <= 0) throw new Error("frameMs too small");
  for (let i = 0; i < bytes.byteLength; i += step) {
    let chunk = bytes.subarray(i, Math.min(i + step, bytes.byteLength));
    if (chunk.byteLength % 2) chunk = chunk.subarray(0, chunk.byteLength - 1);
    if (chunk.byteLength) yield chunk;
  }
}

/** Тишина заданной длины в PCM16. / PCM16 silence of the given length. */
export function silence(ms: number, sampleRate: number = ASR_SAMPLE_RATE): Uint8Array {
  return new Uint8Array(Math.floor((sampleRate * ms) / 1000) * 2);
}

/** Начинается ли буфер с RIFF/WAVE-заголовка. / Whether the buffer looks like a WAV file. */
export function isWav(data: BinaryInput): boolean {
  const b = toBytes(data);
  return b.byteLength >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45;
}

/** Склеить куски в один буфер. / Concatenate chunks. */
export function concatBytes(chunks: BinaryInput[]): Uint8Array {
  const parts = chunks.map(toBytes);
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

const hasBuffer = typeof globalThis !== "undefined" && typeof (globalThis as { Buffer?: unknown }).Buffer === "function";

/** base64 -> байты, в Node через Buffer, в браузере через atob. / Decode base64. */
export function base64ToBytes(b64: string): Uint8Array {
  if (hasBuffer) {
    const B = (globalThis as unknown as { Buffer: { from(s: string, enc: string): Uint8Array } }).Buffer;
    const buf = B.from(b64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** байты -> base64. / Encode base64. */
export function bytesToBase64(data: BinaryInput): string {
  const bytes = toBytes(data);
  if (hasBuffer) {
    const B = (globalThis as unknown as { Buffer: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
    return B.from(bytes).toString("base64");
  }
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
