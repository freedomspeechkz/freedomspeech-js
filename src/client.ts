/**
 * Клиент API Freedom Speech. / Freedom Speech API client.
 *
 * Все вызовы соответствуют публичной документации https://freedomspeech.kz/docs:
 *
 *   POST /v1/audio/transcriptions   transcribe()
 *   WS   /ws/asr                    streamTranscribe(), asrStream()
 *   POST /v1/audio/speech           speak()
 *   WS   /ws/tts                    streamSpeech(), ttsStream()
 *   GET  /api/voices                voices()
 *   GET  /api/voices/{id}/preview   voicePreview()
 *   POST /api/voice-clone           cloneVoice(), cloneVoiceVariants()
 *   POST /api/voice-design          designVoice()
 *   POST /v2/translate              translate()
 *   POST /v2/detect                 detectLanguage()
 *   GET  /v2/languages              languages()
 *   GET  /api/asr/health            health()
 */
import { ASR_SAMPLE_RATE, base64ToBytes, toBytes, type BinaryInput } from "./audio.js";
import { AuthenticationError, ConnectionFailed, FreedomSpeechError, errorFromResponse } from "./errors.js";
import {
  detectionFromJson,
  transcriptionFromJson,
  translationFromJson,
  voiceFromJson,
  type CloneVariant,
  type Detection,
  type Json,
  type Transcription,
  type TranscriptEvent,
  type Translation,
  type Voice,
  type VoiceDesign,
} from "./models.js";
import {
  ASRStream,
  TTSStream,
  defaultWSConnect,
  openSocket,
  transcribeIter,
  type StreamTranscribeOptions,
  type SynthesizeOptions,
  type WSConnect,
  type WebSocketCtor,
} from "./streaming.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://freedomspeech.kz";
export const ENV_API_KEY = "FS_API_KEY";
export const ENV_BASE_URL = "FS_BASE_URL";
export const DEFAULT_TIMEOUT_MS = 60_000;

// Без User-Agent или с UA стандартных библиотек Cloudflare перед API отвечал 403 (код 1010)
// в замерах; строка ниже повторяет форму, с которой рабочий клиент проходил. В браузере этот
// заголовок выставляет сам браузер, а наш отбрасывается без ошибки.
export const DEFAULT_USER_AGENT = `Mozilla/5.0 (X11; Linux x86_64) freedomspeech-js/${VERSION}`;

/** Аудио на вход: Blob/File (браузер и Node 18+), ArrayBuffer, Uint8Array/Buffer или путь к файлу (только Node). */
export type AudioInput = Blob | BinaryInput | string;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FreedomSpeechOptions {
  /** Ключ API. Если не задан, берётся из переменной окружения `FS_API_KEY` (только Node). */
  apiKey?: string;
  /** Адрес API, по умолчанию `https://freedomspeech.kz` (или `FS_BASE_URL`). */
  baseUrl?: string;
  /** Таймаут HTTP-запроса и ожидания кадра по WebSocket, мс. По умолчанию 60 000. */
  timeoutMs?: number;
  /**
   * Дополнительно слать `Authorization: Bearer <ключ>`. Документация описывает только `X-API-Key`;
   * флаг для прокси и будущих версий, по умолчанию выключен.
   */
  bearerAuth?: boolean;
  /** Заголовок User-Agent (в браузере игнорируется самим браузером). */
  userAgent?: string;
  /** Своя функция fetch (прокси, тесты). По умолчанию глобальный `fetch`. */
  fetch?: FetchLike;
  /** Свой конструктор WebSocket (тесты, нестандартные окружения). */
  webSocket?: WebSocketCtor;
  /** Своя фабрика соединений WebSocket; перекрывает `webSocket`. */
  wsConnect?: WSConnect;
}

export interface TranscribeOptions {
  /** Подсказка языка `kk`, `ru`, `en`. В публичной документации поля нет; отправляется только если задано. */
  language?: string;
  /** `true` (по умолчанию) правит сущности, числа и даты; `false` даёт сырой выход, для замера WER. */
  prettify?: boolean;
  /** `true` запрашивает `response_format=diarized_json` с отрезками по говорящим. */
  diarize?: boolean;
  /** Подписи говорящих для диаризации (`known_speaker_names[]`): до 4 имён по порядку появления. */
  speakerNames?: string[];
  /** Имя файла в multipart, если аудио передано байтами. */
  filename?: string;
  /** Поле `model` (OpenAI-совместимость), по умолчанию не отправляется. */
  model?: string;
  timeoutMs?: number;
}

export interface SpeakOptions {
  /** `tomiris` (по умолчанию), `taymas` или id из `voices()`; регистр не важен. */
  voice?: string;
  /** Подсказка языка `kk`, `ru`, `en` (пропускает автоопределение). */
  language?: string;
  /** Только для tomiris: `neutral`, `happy`, `sad`, `surprised`, `angry`, `fearful`. */
  emotion?: string;
  /** Поле `model`. По HTTP работает модель `freedomspeech`; flash доступна через `streamSpeech`. */
  model?: string;
  /** Не описан в документации, ответ всегда WAV; отправляется только если задано. */
  responseFormat?: string;
  timeoutMs?: number;
}

export interface StreamSpeechOptions extends SynthesizeOptions {
  voice?: string;
}

export interface CloneVoiceOptions {
  /** Запись-референс (WAV, MP3, OGG, M4A, FLAC, WebM), рекомендуется до 20 с. */
  referenceAudio?: AudioInput;
  /** Вместо записи: id голоса каталога или `tomiris`. */
  voiceId?: string;
  language?: string;
  /** Множитель темпа, по умолчанию 1.0. */
  speed?: number;
  /** Целевая длительность в секундах; при заданной `duration` `speed` игнорируется. */
  duration?: number;
  filename?: string;
  timeoutMs?: number;
}

export interface DesignVoiceOptions {
  language?: string;
  timeoutMs?: number;
}

export interface TranslateOptions {
  sourceLang?: string;
}

const PUBLIC_PATHS = new Set(["/api/voices", "/v2/languages", "/api/asr/health"]);

function envVar(name: string): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.[name];
}

function mimeOf(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const table: Record<string, string> = {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/ogg",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    flac: "audio/flac",
    webm: "audio/webm",
  };
  return table[ext] ?? "application/octet-stream";
}

async function readAudio(audio: AudioInput, filename: string | undefined, fallback: string): Promise<Blob> {
  if (typeof Blob !== "undefined" && audio instanceof Blob) {
    const name = filename ?? (audio as File).name ?? fallback;
    return audio.type ? audio : new Blob([audio], { type: mimeOf(name) });
  }
  if (typeof audio === "string") {
    const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
    if (isBrowser) throw new TypeError("file paths are not supported in the browser: pass a Blob or File");
    const fsName = "node:fs/promises";
    const fs = (await import(/* @vite-ignore */ /* webpackIgnore: true */ fsName)) as { readFile(p: string): Promise<Uint8Array> };
    const bytes = await fs.readFile(audio);
    const name = filename ?? audio.split(/[\\/]/).pop() ?? fallback;
    return new Blob([bytes as BlobPart], { type: mimeOf(name) });
  }
  if (audio instanceof ArrayBuffer || ArrayBuffer.isView(audio)) {
    const name = filename ?? fallback;
    return new Blob([toBytes(audio) as BlobPart], { type: mimeOf(name) });
  }
  throw new TypeError("audio must be a Blob/File, ArrayBuffer, Uint8Array or a file path");
}

function fileNameFor(audio: AudioInput, filename: string | undefined, fallback: string): string {
  if (filename) return filename;
  if (typeof audio === "string") return audio.split(/[\\/]/).pop() || fallback;
  if (typeof Blob !== "undefined" && audio instanceof Blob && typeof (audio as File).name === "string" && (audio as File).name) {
    return (audio as File).name;
  }
  return fallback;
}

function variantsOf(data: unknown): CloneVariant[] {
  const out: CloneVariant[] = [];
  if (data && typeof data === "object") {
    const list = (data as Json).variants;
    if (Array.isArray(list)) {
      for (const v of list) {
        if (v && typeof v === "object" && typeof (v as Json).wav_base64 === "string") {
          out.push({ engine: String((v as Json).engine ?? ""), wav: base64ToBytes((v as Json).wav_base64 as string) });
        }
      }
    }
  }
  return out;
}

/**
 * Клиент API Freedom Speech: распознавание, синтез, клон голоса, перевод.
 * Freedom Speech API client: speech recognition, synthesis, voice cloning, translation.
 *
 * ```ts
 * const fs = new FreedomSpeech({ apiKey: process.env.FS_API_KEY });
 * const { text } = await fs.transcribe("call.mp3");
 * const wav = await fs.speak("Сәлем", { voice: "tomiris" });
 * ```
 */
export class FreedomSpeech {
  apiKey?: string;
  readonly baseUrl: string;
  timeoutMs: number;
  bearerAuth: boolean;
  userAgent: string;
  private readonly fetchImpl: FetchLike;
  private readonly wsConnect: WSConnect;

  constructor(options: FreedomSpeechOptions = {}) {
    const key = options.apiKey ?? envVar(ENV_API_KEY);
    this.apiKey = key?.trim() || undefined;
    this.baseUrl = (options.baseUrl ?? envVar(ENV_BASE_URL) ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.bearerAuth = options.bearerAuth ?? false;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    const f = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) throw new Error("fetch is not available: use Node 18+ or pass options.fetch");
    this.fetchImpl = f;
    this.wsConnect = options.wsConnect ?? defaultWSConnect(options.webSocket);
  }

  // ------------------------------------------------------------------ служебное

  /** `wss://` адрес для потоковых эндпоинтов. / WebSocket base URL. */
  get wsBaseUrl(): string {
    if (this.baseUrl.startsWith("https://")) return "wss://" + this.baseUrl.slice("https://".length);
    if (this.baseUrl.startsWith("http://")) return "ws://" + this.baseUrl.slice("http://".length);
    return this.baseUrl;
  }

  private requireKey(): string {
    if (!this.apiKey) {
      throw new AuthenticationError(
        "Нет ключа API: передайте apiKey или задайте переменную окружения FS_API_KEY (no API key: pass apiKey or set FS_API_KEY)",
      );
    }
    return this.apiKey;
  }

  private headers(auth: boolean): Record<string, string> {
    const h: Record<string, string> = { "User-Agent": this.userAgent, Accept: "*/*" };
    if (auth && this.apiKey) {
      h["X-API-Key"] = this.apiKey;
      if (this.bearerAuth) h.Authorization = "Bearer " + this.apiKey;
    }
    return h;
  }

  private async request(
    method: string,
    path: string,
    init: {
      auth?: boolean;
      query?: Record<string, string | undefined>;
      json?: unknown;
      form?: FormData;
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    const auth = init.auth ?? true;
    if (auth && !PUBLIC_PATHS.has(path)) this.requireKey();
    let url = this.baseUrl + path;
    if (init.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(init.query)) if (v !== undefined) qs.set(k, v);
      const s = qs.toString();
      if (s) url += "?" + s;
    }
    const headers = this.headers(auth);
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form) {
      body = init.form; // boundary выставит сам fetch
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? this.timeoutMs);
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, { method, headers, body, signal: controller.signal });
    } catch (e) {
      const aborted = (e as { name?: string })?.name === "AbortError";
      throw new ConnectionFailed(
        aborted
          ? `Таймаут запроса (request timed out) ${method} ${path}`
          : `Сетевая ошибка (network error) ${method} ${path}: ${(e as Error)?.message ?? e}`,
        { cause: e },
      );
    } finally {
      clearTimeout(timer);
    }
    if (resp.status >= 400) {
      throw errorFromResponse(resp.status, await bodyOf(resp));
    }
    return resp;
  }

  private async json(resp: Response): Promise<unknown> {
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new FreedomSpeechError(`Сервер вернул не JSON (non-JSON response): ${text.slice(0, 200)}`, {
        status: resp.status,
        body: text,
        cause: e,
      });
    }
  }

  private wsUrl(path: string, query: Record<string, string | undefined> = {}): string {
    const qs = new URLSearchParams({ apiKey: this.requireKey() });
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, v);
    return `${this.wsBaseUrl}${path}?${qs.toString()}`;
  }

  // ------------------------------------------------------------------ распознавание

  /**
   * Распознать файл целиком: `POST /v1/audio/transcriptions`. / Transcribe an audio file.
   *
   * `audio`: Blob/File, ArrayBuffer, Uint8Array или путь к файлу (Node). Форматы: wav, mp3, ogg,
   * oga, m4a, flac, webm, mp4, opus. Язык определяется автоматически.
   */
  async transcribe(audio: AudioInput, opts: TranscribeOptions = {}): Promise<Transcription> {
    const name = fileNameFor(audio, opts.filename, "audio.wav");
    const blob = await readAudio(audio, opts.filename, "audio.wav");
    const form = new FormData();
    form.append("file", blob, name);
    form.append("prettify", opts.prettify === false ? "false" : "true");
    if (opts.diarize) {
      form.append("response_format", "diarized_json");
      for (const s of opts.speakerNames ?? []) form.append("known_speaker_names[]", s);
    }
    if (opts.language) form.append("language", opts.language);
    if (opts.model) form.append("model", opts.model);
    const resp = await this.request("POST", "/v1/audio/transcriptions", { form, timeoutMs: opts.timeoutMs });
    const data = await this.json(resp);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new FreedomSpeechError(`Неожиданный ответ (unexpected response): ${JSON.stringify(data)}`, { status: resp.status, body: data });
    }
    return transcriptionFromJson(data as Json);
  }

  /**
   * Открыть `WS /ws/asr` и дождаться `ready`. / Open a streaming-recognition socket.
   * Вход: сырой PCM16, 16 кГц, моно, без контейнера. Сервер не пересэмплирует и не распаковывает
   * контейнеры; неверный формат даёт пустой или бессмысленный текст без ошибки.
   */
  async asrStream(opts: { prettify?: boolean } = {}): Promise<ASRStream> {
    const url = this.wsUrl("/ws/asr", { prettify: opts.prettify === false ? "false" : undefined });
    const q = await openSocket(this.wsConnect, url, { "User-Agent": this.userAgent }, this.timeoutMs);
    const stream = new ASRStream(q, this.timeoutMs);
    try {
      await stream.waitReady();
    } catch (e) {
      stream.close();
      throw e;
    }
    return stream;
  }

  /**
   * Потоковое распознавание по `WS /ws/asr`: асинхронный генератор `partial`/`final`.
   * Stream PCM16 chunks and yield partial/final events.
   *
   * Длинную речь сервер режет на отрезки по паузам и шлёт `final` на каждый:
   * итоговый текст собирается из всех `final`, не из последнего.
   */
  async *streamTranscribe(
    pcm16Chunks: Iterable<BinaryInput> | AsyncIterable<BinaryInput>,
    opts: StreamTranscribeOptions & { prettify?: boolean } = {},
  ): AsyncGenerator<TranscriptEvent> {
    const stream = await this.asrStream({ prettify: opts.prettify });
    try {
      yield* transcribeIter(stream, pcm16Chunks, { ...opts, sampleRate: opts.sampleRate ?? ASR_SAMPLE_RATE });
    } finally {
      stream.close();
    }
  }

  // ------------------------------------------------------------------ синтез

  /**
   * Озвучить текст: `POST /v1/audio/speech`, в ответ WAV (16 бит, моно, 24 кГц). / Synthesize to WAV bytes.
   * В тексте допустимы теги просодии `<pause>`, `<louder>...</louder>`, `<slower>...</slower>`;
   * у голоса tomiris ещё неречевые `<sigh>`, `<laugh>` и другие.
   */
  async speak(text: string, opts: SpeakOptions = {}): Promise<Uint8Array> {
    if (!text || !text.trim()) throw new Error("text is required");
    const body: Json = { input: text, voice: opts.voice ?? "tomiris" };
    if (opts.language) body.language = opts.language;
    if (opts.emotion) body.emotion = opts.emotion;
    if (opts.model) body.model = opts.model;
    if (opts.responseFormat) body.response_format = opts.responseFormat;
    const resp = await this.request("POST", "/v1/audio/speech", { json: body, timeoutMs: opts.timeoutMs });
    return new Uint8Array(await resp.arrayBuffer());
  }

  /** Открыть `WS /ws/tts` для нескольких запросов на одном тёплом соединении. / Open a TTS socket. */
  async ttsStream(): Promise<TTSStream> {
    const q = await openSocket(this.wsConnect, this.wsUrl("/ws/tts"), { "User-Agent": this.userAgent }, this.timeoutMs);
    return new TTSStream(q, this.timeoutMs);
  }

  /**
   * Потоковый синтез по `WS /ws/tts`: асинхронный генератор кусков PCM16 (24 кГц, моно).
   * Stream synthesis: yields raw PCM16 chunks as the server generates them.
   *
   * `model`: `freedomspeech-flash` (по умолчанию здесь, звук идёт по мере синтеза) или
   * `freedomspeech` (синтезирует фразу целиком и отдаёт её кусками). Собрать WAV:
   * `pcm16ToWav(concatBytes(chunks))`. Для многих фраз подряд откройте одно соединение
   * через `ttsStream()`: первый запрос на новом сокете заметно медленнее.
   */
  async *streamSpeech(text: string, opts: StreamSpeechOptions = {}): AsyncGenerator<Uint8Array> {
    const stream = await this.ttsStream();
    try {
      yield* stream.synthesize(text, opts.voice ?? "tomiris", {
        model: opts.model ?? "freedomspeech-flash",
        language: opts.language,
        emotion: opts.emotion,
        requestId: opts.requestId,
      });
    } finally {
      stream.close();
    }
  }

  // ------------------------------------------------------------------ голоса

  /** Список голосов: `GET /api/voices`, без ключа. / List catalog voices. */
  async voices(): Promise<Voice[]> {
    let data = await this.json(await this.request("GET", "/api/voices", { auth: false }));
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const d = data as Json;
      data = d.voices ?? d.data ?? [];
    }
    return (Array.isArray(data) ? data : []).filter((v): v is Json => !!v && typeof v === "object").map(voiceFromJson);
  }

  /**
   * Готовый образец голоса каталога: `GET /api/voices/{id}/preview`, WAV. / Catalog voice preview.
   * У встроенных голосов образца нет (404): озвучьте фразу через `speak`.
   */
  async voicePreview(voiceId: string): Promise<Uint8Array> {
    const resp = await this.request("GET", `/api/voices/${encodeURIComponent(voiceId)}/preview`, { auth: false });
    return new Uint8Array(await resp.arrayBuffer());
  }

  /**
   * Озвучить текст голосом из записи или голосом каталога: `POST /api/voice-clone`, в ответ WAV.
   * Clone a voice from a reference recording (or catalog voice) and speak the text.
   * Нужно ровно одно из `referenceAudio` и `voiceId`.
   */
  async cloneVoice(text: string, opts: CloneVoiceOptions): Promise<Uint8Array> {
    const form = await this.cloneForm(text, opts);
    const resp = await this.request("POST", "/api/voice-clone", { form, timeoutMs: opts.timeoutMs ?? Math.max(this.timeoutMs, 180_000) });
    return new Uint8Array(await resp.arrayBuffer());
  }

  /**
   * То же, что `cloneVoice`, но `?variants=all`: результат каждого движка (`omnivoice`, `flash`).
   * Упавший движок в списке отсутствует; 502 приходит, только если упали все.
   */
  async cloneVoiceVariants(text: string, opts: CloneVoiceOptions): Promise<CloneVariant[]> {
    const form = await this.cloneForm(text, opts);
    const resp = await this.request("POST", "/api/voice-clone", {
      query: { variants: "all" },
      form,
      timeoutMs: opts.timeoutMs ?? Math.max(this.timeoutMs, 180_000),
    });
    return variantsOf(await this.json(resp));
  }

  /**
   * Создать голос по описанию и озвучить им текст: `POST /api/voice-design`.
   * Design a voice from a text description and speak the text with it.
   * `instruct`: описание голоса; по документации лучше работает по-английски, казахское описание
   * сервер переводит сам. Стоит указать пол, возраст, высоту, темп, эмоцию, тембр, сценарий.
   */
  async designVoice(text: string, instruct: string, opts: DesignVoiceOptions = {}): Promise<VoiceDesign> {
    if (!text || !text.trim()) throw new Error("text is required");
    if (!instruct || !instruct.trim()) throw new Error("instruct is required");
    const body: Json = { text, instruct };
    if (opts.language) body.language = opts.language;
    const resp = await this.request("POST", "/api/voice-design", { json: body, timeoutMs: opts.timeoutMs ?? Math.max(this.timeoutMs, 180_000) });
    const data = await this.json(resp);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new FreedomSpeechError("Неожиданный ответ (unexpected response)", { status: resp.status, body: data });
    }
    const d = data as Json;
    return {
      referenceWav: typeof d.reference_wav_base64 === "string" ? base64ToBytes(d.reference_wav_base64) : new Uint8Array(0),
      wav: typeof d.voice_clone_wav_base64 === "string" ? base64ToBytes(d.voice_clone_wav_base64) : undefined,
      variants: variantsOf(d),
      raw: d,
    };
  }

  // ------------------------------------------------------------------ текст

  /**
   * Перевести строки между kk, ru, en: `POST /v2/translate`. / Translate up to 50 strings.
   * Порядок и число результатов совпадают с входом. `detectedSourceLanguage` заполнено,
   * только если `sourceLang` не передан.
   */
  async translate(text: string | string[], targetLang: string, opts: TranslateOptions = {}): Promise<Translation[]> {
    const body: Json = { text, target_lang: targetLang };
    if (opts.sourceLang) body.source_lang = opts.sourceLang;
    const data = await this.json(await this.request("POST", "/v2/translate", { json: body }));
    const items = data && typeof data === "object" ? (data as Json).translations : [];
    return (Array.isArray(items) ? items : []).filter((t): t is Json => !!t && typeof t === "object").map(translationFromJson);
  }

  /** Определить язык строк: `POST /v2/detect`. / Detect the language of up to 50 strings. */
  async detectLanguage(text: string | string[]): Promise<Detection[]> {
    const data = await this.json(await this.request("POST", "/v2/detect", { json: { text } }));
    const items = data && typeof data === "object" ? (data as Json).detections : [];
    return (Array.isArray(items) ? items : []).filter((t): t is Json => !!t && typeof t === "object").map(detectionFromJson);
  }

  /** Языки перевода: `GET /v2/languages`, без ключа. / Supported translation languages. */
  async languages(): Promise<Json> {
    return (await this.json(await this.request("GET", "/v2/languages", { auth: false }))) as Json;
  }

  // ------------------------------------------------------------------ сервис

  /**
   * Состояние распознавания: `GET /api/asr/health`, без ключа. / ASR service health.
   * При 503 бросает `FreedomSpeechError` с телом `{"status": "unavailable", ...}`.
   */
  async health(): Promise<Json> {
    return (await this.json(await this.request("GET", "/api/asr/health", { auth: false }))) as Json;
  }

  // ------------------------------------------------------------------ внутреннее

  private async cloneForm(text: string, opts: CloneVoiceOptions): Promise<FormData> {
    if (!text || !text.trim()) throw new Error("text is required");
    const hasRef = opts.referenceAudio !== undefined && opts.referenceAudio !== null;
    const hasId = opts.voiceId !== undefined && opts.voiceId !== null;
    if (hasRef === hasId) throw new Error("pass exactly one of referenceAudio or voiceId");
    const form = new FormData();
    form.append("text", text);
    if (hasRef) {
      const audio = opts.referenceAudio as AudioInput;
      const name = fileNameFor(audio, opts.filename, "reference.wav");
      form.append("audio", await readAudio(audio, opts.filename, "reference.wav"), name);
    } else {
      form.append("voice_id", opts.voiceId as string);
    }
    if (opts.language) form.append("language", opts.language);
    if (opts.speed !== undefined) form.append("speed", String(opts.speed));
    if (opts.duration !== undefined) form.append("duration", String(opts.duration));
    return form;
  }
}

async function bodyOf(resp: Response): Promise<unknown> {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
