/**
 * Структуры ответов API. / Response types.
 *
 * Поля повторяют публичную документацию https://freedomspeech.kz/docs.
 * Исходный JSON всегда доступен в поле `raw`.
 */

export type Json = Record<string, unknown>;

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Отрезок стенограммы с таймкодами (`response_format=diarized_json`). / Transcript segment. */
export interface Segment {
  id?: string;
  start?: number;
  end?: number;
  text: string;
  speaker?: string;
  type?: string;
  raw: Json;
}

/**
 * Ответ `POST /v1/audio/transcriptions`. / Transcription result.
 *
 * `text`: стенограмма; `duration`: длительность аудио, с; `processingTime`: время обработки
 * на сервере, с (сервер может не прислать); `language`: определённый язык;
 * `segments`: отрезки по говорящим, только при `diarize: true`.
 */
export interface Transcription {
  text: string;
  duration?: number;
  processingTime?: number;
  language?: string;
  segments: Segment[];
  task?: string;
  raw: Json;
}

/** Событие потока `WS /ws/asr`: `partial` или `final`. / Streaming ASR event. */
export interface TranscriptEvent {
  type: "partial" | "final" | string;
  text: string;
  /** Приходит только с `final`. / Present on `final` frames only. */
  language?: string;
  isFinal: boolean;
  raw: Json;
}

/** Голос из `GET /api/voices`. / Catalog voice. `type`: `builtin` или `custom`. */
export interface Voice {
  id: string;
  name: string;
  type?: string;
  raw: Json;
}

/** Результат одного движка при `variants=all`. / One engine's result of voice cloning. */
export interface CloneVariant {
  /** `omnivoice` (модель freedomspeech) или `flash` (freedomspeech-flash). */
  engine: string;
  /** Готовый WAV-файл. / A complete WAV file. */
  wav: Uint8Array;
}

/**
 * Ответ `POST /api/voice-design`. / Voice design result.
 *
 * `referenceWav`: образец спроектированного голоса; его можно отдать как референс в `cloneVoice`.
 * `variants`: тот же текст, озвученный каждым движком. `wav`: первый удачный вариант.
 */
export interface VoiceDesign {
  referenceWav: Uint8Array;
  wav?: Uint8Array;
  variants: CloneVariant[];
  raw: Json;
}

/** Одна строка ответа `POST /v2/translate`. / One translated item. */
export interface Translation {
  text: string;
  detectedSourceLanguage?: string;
  raw: Json;
}

/** Одна строка ответа `POST /v2/detect`. / One language detection item. */
export interface Detection {
  text: string;
  language?: string;
  raw: Json;
}

export function segmentFromJson(data: Json): Segment {
  return {
    id: str(data.id),
    start: num(data.start),
    end: num(data.end),
    text: String(data.text ?? ""),
    speaker: str(data.speaker),
    type: str(data.type),
    raw: data,
  };
}

export function transcriptionFromJson(data: Json): Transcription {
  const segs = Array.isArray(data.segments) ? data.segments : [];
  return {
    text: String(data.text ?? ""),
    duration: num(data.duration),
    processingTime: num(data.processingTime),
    language: str(data.language),
    segments: segs.filter((s): s is Json => !!s && typeof s === "object").map(segmentFromJson),
    task: str(data.task),
    raw: data,
  };
}

export function transcriptEventFromJson(data: Json): TranscriptEvent {
  const type = String(data.type ?? "");
  return { type, text: String(data.text ?? ""), language: str(data.language), isFinal: type === "final", raw: data };
}

export function voiceFromJson(data: Json): Voice {
  const id = String(data.id ?? "");
  return { id, name: String(data.name ?? id), type: str(data.type), raw: data };
}

export function translationFromJson(data: Json): Translation {
  return { text: String(data.text ?? ""), detectedSourceLanguage: str(data.detected_source_language), raw: data };
}

export function detectionFromJson(data: Json): Detection {
  return { text: String(data.text ?? ""), language: str(data.detected_source_language), raw: data };
}
