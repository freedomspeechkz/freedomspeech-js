/**
 * Потоковые соединения: `WS /ws/asr` и `WS /ws/tts`. / WebSocket streams for ASR and TTS.
 *
 * Протоколы по https://freedomspeech.kz/docs (разделы «WS: ASR streaming» и «WS: TTS streaming»).
 *
 * ASR (`/ws/asr?apiKey=...&prettify=...`):
 *   клиент -> сервер: бинарные кадры PCM16 16 кГц моно; `{"type": "stop"}` закрывает текущую фразу;
 *   сервер -> клиент: `{"type": "ready"}`, `{"type": "partial", "text"}`,
 *   `{"type": "final", "text", "language"}`, `{"type": "error", "message"}`.
 *   Соединение закрывается сервером после 15 с без аудио.
 *
 * TTS (`/ws/tts?apiKey=...`):
 *   клиент -> сервер: `{"type": "synthesize", "text", "voice", "emotion", "language", "model", "requestId"}`,
 *   `{"type": "cancel", "requestId"?}`;
 *   сервер -> клиент: `audio_chunk{audio: base64 PCM16, chunkIndex, sampleRate, format}`,
 *   `audio_end{totalChunks, sampleRate}`, `cancelled{totalChunks}`, `error{code, message}`.
 *   На одном соединении очередь до 8 запросов, ожидание до 60 с.
 */
import { ASR_SAMPLE_RATE, TTS_SAMPLE_RATE, base64ToBytes, toBytes, type BinaryInput } from "./audio.js";
import { AuthenticationError, ConnectionFailed, FreedomSpeechError, StreamError } from "./errors.js";
import { transcriptEventFromJson, type Json, type TranscriptEvent } from "./models.js";

// ------------------------------------------------------------------ WebSocket abstraction

/** Минимальный интерфейс сокета: браузерный WebSocket, Node 22 WebSocket и пакет `ws` ему удовлетворяют. */
export interface WSLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: (ev: unknown) => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
}

export type WebSocketCtor = new (url: string, protocolsOrOptions?: unknown) => WSLike;

/** Фабрика соединения: вернуть открытый сокет. / Connector: return a socket (open or opening). */
export type WSConnect = (url: string, headers: Record<string, string>) => Promise<WSLike> | WSLike;

let cachedCtor: Promise<{ ctor: WebSocketCtor; supportsHeaders: boolean }> | undefined;

/**
 * В Node предпочитаем пакет `ws` (он умеет заголовки), иначе глобальный WebSocket (Node 22+, браузер).
 * In Node prefer the `ws` package (custom headers), otherwise the global WebSocket (Node 22+, browsers).
 */
async function resolveWebSocket(): Promise<{ ctor: WebSocketCtor; supportsHeaders: boolean }> {
  if (!cachedCtor) {
    cachedCtor = (async () => {
      const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
      if (!isBrowser) {
        try {
          const name = "ws";
          const mod = (await import(/* @vite-ignore */ /* webpackIgnore: true */ name)) as {
            default?: WebSocketCtor;
            WebSocket?: WebSocketCtor;
          };
          const ctor = mod.default ?? mod.WebSocket;
          if (ctor) return { ctor, supportsHeaders: true };
        } catch {
          // пакет ws не установлен
        }
      }
      const g = globalThis as { WebSocket?: WebSocketCtor };
      if (typeof g.WebSocket === "function") return { ctor: g.WebSocket, supportsHeaders: false };
      throw new ConnectionFailed(
        "Нет реализации WebSocket: установите пакет ws (npm i ws) или используйте Node 22+ / браузер (no WebSocket implementation available)",
      );
    })();
  }
  return cachedCtor;
}

export function defaultWSConnect(impl?: WebSocketCtor): WSConnect {
  return async (url, headers) => {
    if (impl) return new impl(url);
    const { ctor, supportsHeaders } = await resolveWebSocket();
    return supportsHeaders ? new ctor(url, { headers, maxPayload: 0 }) : new ctor(url);
  };
}

type Frame = { kind: "json"; data: Json } | { kind: "binary"; data: Uint8Array } | { kind: "closed"; error: FreedomSpeechError };

/** Очередь кадров с ожиданием. / A socket wrapped as a frame queue with awaitable reads. */
export class FrameQueue {
  private frames: Frame[] = [];
  private waiters: Array<(f: Frame) => void> = [];
  private closedFrame?: Extract<Frame, { kind: "closed" }>;
  readonly opened: Promise<void>;

  constructor(readonly ws: WSLike, openTimeoutMs: number) {
    try {
      ws.binaryType = "arraybuffer";
    } catch {
      // некоторые реализации не дают менять binaryType до open
    }
    this.opened = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new ConnectionFailed(`Не удалось открыть WebSocket за ${Math.round(openTimeoutMs / 1000)} с (connect timeout)`));
      }, openTimeoutMs);
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      if (ws.readyState === 1) done(resolve);
      ws.addEventListener("open", () => done(resolve));
      ws.addEventListener("error", (ev) => {
        const message = describeError(ev);
        const err = /401/.test(message)
          ? new AuthenticationError(
              `Ключ не принят при открытии WebSocket: проверьте apiKey или FS_API_KEY (API key was not accepted): ${message}`,
              { status: 401 },
            )
          : new ConnectionFailed(`Ошибка WebSocket (socket error): ${message}`);
        done(() => reject(err));
        this.push({ kind: "closed", error: err });
      });
      ws.addEventListener("close", (ev) => {
        const err = new ConnectionFailed(
          `Соединение закрыто сервером (connection closed): code=${ev?.code ?? "?"} ${ev?.reason ?? ""}`.trim(),
        );
        done(() => reject(err));
        this.push({ kind: "closed", error: err });
      });
      ws.addEventListener("message", (ev) => {
        const data = ev.data;
        if (typeof data === "string") {
          try {
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed === "object") this.push({ kind: "json", data: parsed as Json });
          } catch {
            // не JSON, пропускаем
          }
        } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
          this.push({ kind: "binary", data: toBytes(data as BinaryInput) });
        } else if (data && typeof (data as Blob).arrayBuffer === "function") {
          void (data as Blob).arrayBuffer().then((buf) => this.push({ kind: "binary", data: new Uint8Array(buf) }));
        }
      });
    });
    // чтобы необработанный reject не ронял процесс, если opened никто не ждёт
    this.opened.catch(() => undefined);
  }

  private push(frame: Frame): void {
    if (this.closedFrame) return;
    if (frame.kind === "closed") this.closedFrame = frame;
    const waiter = this.waiters.shift();
    if (waiter) waiter(frame);
    else this.frames.push(frame);
  }

  /** Следующий JSON-кадр; null по таймауту; ConnectionFailed после закрытия. */
  async nextJson(timeoutMs: number | undefined): Promise<Json | null> {
    for (;;) {
      const frame = await this.next(timeoutMs);
      if (frame === null) return null;
      if (frame.kind === "closed") throw frame.error;
      if (frame.kind === "json") return frame.data;
      // бинарные кадры в этих протоколах сервер не шлёт, пропускаем
    }
  }

  private next(timeoutMs: number | undefined): Promise<Frame | null> {
    const queued = this.frames.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closedFrame) return Promise.resolve(this.closedFrame);
    return new Promise<Frame | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (f: Frame) => {
        if (timer) clearTimeout(timer);
        resolve(f);
      };
      if (timeoutMs !== undefined && timeoutMs !== Infinity) {
        timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(null);
        }, Math.max(0, timeoutMs));
      }
      this.waiters.push(waiter);
    });
  }

  send(data: string | Uint8Array): void {
    if (this.closedFrame) throw this.closedFrame.error;
    try {
      this.ws.send(data);
    } catch (e) {
      throw new ConnectionFailed(`Не удалось отправить кадр (send failed): ${describeError(e)}`, { cause: e });
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; error?: { message?: unknown } };
    if (typeof o.message === "string") return o.message;
    if (o.error && typeof o.error.message === "string") return o.error.message;
  }
  return String(e ?? "unknown");
}

export async function openSocket(connect: WSConnect, url: string, headers: Record<string, string>, timeoutMs: number): Promise<FrameQueue> {
  let ws: WSLike;
  try {
    ws = await connect(url, headers);
  } catch (e) {
    if (e instanceof FreedomSpeechError) throw e;
    throw new ConnectionFailed(`Не удалось открыть WebSocket (connect failed): ${describeError(e)}`, { cause: e });
  }
  const queue = new FrameQueue(ws, timeoutMs);
  await queue.opened;
  return queue;
}

// ------------------------------------------------------------------ ASR

/**
 * Открытое соединение `WS /ws/asr`. / An open streaming-recognition connection.
 *
 * ```ts
 * const s = await fs.asrStream();
 * for (const frame of frames) s.send(frame);   // PCM16, 16 кГц, моно, без заголовка
 * s.stop();
 * for await (const ev of s.events()) { if (ev.isFinal) console.log(ev.text); }
 * s.close();
 * ```
 *
 * Соединение держите тёплым: первая фраза на новом сокете начинается с задержкой, следующие идут
 * без прогрева. `stop` завершает фразу, сокет остаётся открытым.
 */
export class ASRStream {
  ready = false;
  closed = false;

  constructor(
    private readonly q: FrameQueue,
    readonly timeoutMs: number,
  ) {}

  /** Дождаться `{"type": "ready"}`; до него аудио слать нельзя. / Wait for the ready frame. */
  async waitReady(timeoutMs: number = this.timeoutMs): Promise<void> {
    if (this.ready) return;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new ConnectionFailed(`Сервер не прислал ready за ${Math.round(timeoutMs / 1000)} с (no ready frame)`);
      const msg = await this.q.nextJson(left);
      if (msg === null) continue;
      if (msg.type === "ready") {
        this.ready = true;
        return;
      }
      if (msg.type === "error") throw new StreamError(String(msg.message ?? "error"), { body: msg, code: msg.code as string | undefined });
    }
  }

  /** Отправить кадр PCM16 (16 кГц, моно, little-endian, чётное число байт). / Send a PCM16 frame. */
  send(pcm16: BinaryInput): void {
    const bytes = toBytes(pcm16);
    if (bytes.byteLength % 2) throw new Error("PCM16 frame must contain whole samples (even number of bytes)");
    if (!this.ready) throw new Error("call waitReady() before send()");
    this.q.send(bytes);
  }

  /** Завершить текущую фразу: `{"type": "stop"}`. Сокет остаётся открытым. / Force a final. */
  stop(): void {
    this.q.send(JSON.stringify({ type: "stop" }));
  }

  /**
   * Одно событие `partial`/`final` или null по таймауту. / One event or null on timeout.
   * Кадр `error` бросает `StreamError`, закрытие сокета бросает `ConnectionFailed`.
   */
  async recv(timeoutMs?: number): Promise<TranscriptEvent | null> {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    for (;;) {
      const left = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
      const msg = await this.q.nextJson(left);
      if (msg === null) return null;
      const t = msg.type;
      if (t === "ready") {
        this.ready = true;
        continue;
      }
      if (t === "partial" || t === "final") return transcriptEventFromJson(msg);
      if (t === "error") throw new StreamError(String(msg.message ?? "error"), { body: msg, code: msg.code as string | undefined });
      // неизвестные типы пропускаем
    }
  }

  /** Все события, накопившиеся за `timeoutMs`. / Drain events available within the timeout. */
  async *poll(timeoutMs = 0): AsyncGenerator<TranscriptEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ev = await this.recv(Math.max(0, deadline - Date.now()));
      if (ev === null) return;
      yield ev;
    }
  }

  /** События до закрытия соединения. / Iterate events until the socket closes. */
  async *events(): AsyncGenerator<TranscriptEvent> {
    try {
      for (;;) {
        const ev = await this.recv();
        if (ev !== null) yield ev;
      }
    } catch (e) {
      if (e instanceof ConnectionFailed) return;
      throw e;
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.q.close();
    }
  }
}

export interface StreamTranscribeOptions {
  /** Выдерживать темп живой речи (пауза по длительности кадра). / Pace frames in real time. */
  realtime?: boolean;
  /** После последнего кадра отправить `stop`, чтобы получить `final`. По умолчанию true. */
  stop?: boolean;
  /** Сколько миллисекунд ждать `final` после конца аудио. По умолчанию 5000. */
  finalTimeoutMs?: number;
  sampleRate?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Прогнать кадры PCM16 через открытый `ASRStream`, отдавая события по мере прихода.
 * Отправка идёт параллельно чтению. После конца аудио отправляется `stop` (если включён),
 * затем события читаются ещё `finalTimeoutMs` или до первого `final`, пришедшего после `stop`.
 */
export async function* transcribeIter(
  stream: ASRStream,
  chunks: Iterable<BinaryInput> | AsyncIterable<BinaryInput>,
  opts: StreamTranscribeOptions = {},
): AsyncGenerator<TranscriptEvent> {
  const { realtime = false, stop = true, finalTimeoutMs = 5000, sampleRate = ASR_SAMPLE_RATE } = opts;
  await stream.waitReady();
  let done = false;
  let doneAt = 0;
  let sendError: unknown;

  const sender = (async () => {
    try {
      for await (const chunk of chunks as AsyncIterable<BinaryInput>) {
        if (stream.closed) break;
        const bytes = toBytes(chunk);
        stream.send(bytes);
        if (realtime) await sleep((bytes.byteLength / (2 * sampleRate)) * 1000);
      }
      if (stop && !stream.closed) stream.stop();
    } catch (e) {
      sendError = e;
    } finally {
      doneAt = Date.now();
      done = true;
    }
  })();

  try {
    for (;;) {
      if (sendError) throw sendError;
      const ev = await stream.recv(200);
      if (ev !== null) {
        yield ev;
        if (done && ev.isFinal && Date.now() >= doneAt) break;
        continue;
      }
      if (done && Date.now() - doneAt > finalTimeoutMs) break;
    }
  } finally {
    done = true;
    await Promise.race([sender, sleep(1000)]);
  }
}

// ------------------------------------------------------------------ TTS

export interface SynthesizeOptions {
  /** `freedomspeech` (по умолчанию на сервере) или `freedomspeech-flash`. */
  model?: string;
  language?: string;
  emotion?: string;
  requestId?: string;
}

function newRequestId(): string {
  const rnd = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(16).slice(2) + Date.now().toString(16);
  return "req-" + rnd.slice(0, 12);
}

/**
 * Открытое соединение `WS /ws/tts`. / An open streaming-synthesis connection.
 *
 * ```ts
 * const s = await fs.ttsStream();
 * const pcm = concatBytes(await collect(s.synthesize("Сәлем", "tomiris", { model: "freedomspeech-flash" })));
 * s.close();
 * ```
 *
 * Запросы на одном соединении выполняются по очереди (до 8 в ожидании, до 60 с ожидания).
 * Звук приходит сырым PCM16 24 кГц моно; обернуть в WAV: `pcm16ToWav`.
 */
export class TTSStream {
  closed = false;
  sampleRate: number = TTS_SAMPLE_RATE;
  lastTotalChunks?: number;

  constructor(
    private readonly q: FrameQueue,
    readonly timeoutMs: number,
  ) {}

  /**
   * Отправить `synthesize` и отдавать куски PCM16 до `audio_end`. / Stream PCM16 chunks.
   * Неизвестную модель сервер заменяет на `freedomspeech`. Кадр `error` бросает `StreamError`
   * с `code` (`queue_full`, `queue_timeout`, `upstream_failed` и другие). Кадр `cancelled`
   * завершает генератор без ошибки.
   */
  async *synthesize(text: string, voice?: string, opts: SynthesizeOptions = {}): AsyncGenerator<Uint8Array> {
    if (!text || !text.trim()) throw new Error("text is required");
    const rid = opts.requestId ?? newRequestId();
    const req: Json = { type: "synthesize", text, requestId: rid };
    if (voice !== undefined) req.voice = voice;
    if (opts.model !== undefined) req.model = opts.model;
    if (opts.language !== undefined) req.language = opts.language;
    if (opts.emotion !== undefined) req.emotion = opts.emotion;
    this.q.send(JSON.stringify(req));
    // запрос может ждать в очереди до 60 с, поэтому ждём дольше обычного таймаута
    const wait = Math.max(this.timeoutMs, 90_000);
    for (;;) {
      const msg = await this.q.nextJson(wait);
      if (msg === null) throw new ConnectionFailed(`Нет ответа от /ws/tts за ${Math.round(wait / 1000)} с (no frame received)`);
      const mrid = msg.requestId;
      if (mrid !== undefined && mrid !== null && mrid !== rid) continue; // кадр другого запроса
      const t = msg.type;
      if (t === "audio_chunk") {
        if (typeof msg.sampleRate === "number" && msg.sampleRate > 0) this.sampleRate = msg.sampleRate;
        if (typeof msg.audio === "string" && msg.audio) yield base64ToBytes(msg.audio);
      } else if (t === "audio_end") {
        this.lastTotalChunks = typeof msg.totalChunks === "number" ? msg.totalChunks : undefined;
        if (typeof msg.sampleRate === "number" && msg.sampleRate > 0) this.sampleRate = msg.sampleRate;
        return;
      } else if (t === "cancelled") {
        this.lastTotalChunks = typeof msg.totalChunks === "number" ? msg.totalChunks : undefined;
        return;
      } else if (t === "error") {
        throw new StreamError(String(msg.message ?? "error"), { body: msg, code: msg.code as string | undefined });
      }
      // text_chunk и прочие служебные кадры пропускаем
    }
  }

  /** Отменить один запрос по `requestId` или (без аргумента) текущий и всю очередь. / Cancel. */
  cancel(requestId?: string): void {
    const msg: Json = { type: "cancel" };
    if (requestId) msg.requestId = requestId;
    this.q.send(JSON.stringify(msg));
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.q.close();
    }
  }
}
