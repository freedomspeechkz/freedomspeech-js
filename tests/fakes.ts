/** Моки без сети: поддельный fetch и поддельный WebSocket. / Network-free fakes. */
import type { FetchLike } from "../src/client.js";
import type { WSLike } from "../src/streaming.js";

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  json?: unknown;
  form?: FormData;
  body?: BodyInit | null;
}

export class FakeFetch {
  calls: RecordedCall[] = [];
  queue: Response[] = [];

  push(resp: Response): this {
    this.queue.push(resp);
    return this;
  }

  json(status: number, body: unknown): this {
    return this.push(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  }

  bytes(status: number, data: Uint8Array, type = "audio/wav"): this {
    return this.push(new Response(data as BodyInit, { status, headers: { "Content-Type": type } }));
  }

  text(status: number, text: string, type = "text/html"): this {
    return this.push(new Response(text, { status, headers: { "Content-Type": type } }));
  }

  get fetch(): FetchLike {
    return async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: RecordedCall = { method: init?.method ?? "GET", url, headers, body: init?.body ?? null };
      if (typeof init?.body === "string") {
        try {
          call.json = JSON.parse(init.body);
        } catch {
          // not json
        }
      } else if (init?.body instanceof FormData) {
        call.form = init.body;
      }
      this.calls.push(call);
      const resp = this.queue.shift();
      if (!resp) throw new Error(`unexpected request ${call.method} ${url}`);
      return resp;
    };
  }

  get last(): RecordedCall {
    return this.calls[this.calls.length - 1];
  }
}

type Listener = (ev: unknown) => void;
type Scripted = Record<string, unknown> | Uint8Array | ((ws: FakeWebSocket) => Record<string, unknown> | null) | { closeWith: number };

/**
 * Поддельный сокет: открывается на следующем тике, отдаёт заготовленные кадры, запоминает отправленное.
 * Кадры-функции вызываются после каждого `send` и могут вернуть ответ (null = ничего).
 */
export class FakeWebSocket implements WSLike {
  static instances: FakeWebSocket[] = [];
  static script: Scripted[] = [];
  static failOpen: string | undefined;

  binaryType = "blob";
  readyState = 0;
  sent: Array<string | Uint8Array> = [];
  closed = false;
  readonly url: string;
  readonly options: unknown;
  private listeners: Record<string, Listener[]> = { open: [], message: [], close: [], error: [] };
  private pending: Scripted[];

  constructor(url: string, options?: unknown) {
    this.url = url;
    this.options = options;
    this.pending = [...FakeWebSocket.script];
    FakeWebSocket.script = [];
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      if (FakeWebSocket.failOpen) {
        const msg = FakeWebSocket.failOpen;
        FakeWebSocket.failOpen = undefined;
        this.emit("error", { message: msg });
        this.readyState = 3;
        this.emit("close", { code: 1006, reason: msg });
        return;
      }
      this.readyState = 1;
      this.emit("open", {});
      this.flush();
    }, 0);
  }

  /** Отдать все заготовленные кадры до первого реактивного (функции). */
  private flush(): void {
    while (this.pending.length && !this.closed) {
      const item = this.pending[0];
      if (typeof item === "function") return; // ждём send
      this.pending.shift();
      this.deliver(item);
    }
  }

  private deliver(item: Scripted): void {
    if (typeof item === "function") return;
    if (item instanceof Uint8Array) {
      this.emit("message", { data: item.buffer.slice(item.byteOffset, item.byteOffset + item.byteLength) });
    } else if ("closeWith" in item && typeof item.closeWith === "number" && Object.keys(item).length === 1) {
      this.readyState = 3;
      this.closed = true;
      this.emit("close", { code: item.closeWith, reason: "server closed" });
    } else {
      this.emit("message", { data: JSON.stringify(item) });
    }
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closed) throw new Error("socket closed");
    if (typeof data === "string") this.sent.push(data);
    else if (data instanceof ArrayBuffer) this.sent.push(new Uint8Array(data));
    else this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    // реактивные кадры: после отправки спросить сценарий
    setTimeout(() => {
      while (this.pending.length && typeof this.pending[0] === "function") {
        const fn = this.pending[0] as (ws: FakeWebSocket) => Record<string, unknown> | null;
        const out = fn(this);
        if (out === null) return; // ещё не время
        this.pending.shift();
        this.deliver(out);
      }
      this.flush();
    }, 0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    setTimeout(() => this.emit("close", { code: 1000, reason: "" }), 0);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners[type].push(listener);
  }

  private emit(type: string, ev: unknown): void {
    for (const l of this.listeners[type]) l(ev);
  }

  sentJson(): Array<Record<string, unknown>> {
    return this.sent.filter((x): x is string => typeof x === "string").map((x) => JSON.parse(x));
  }

  sentBytes(): Uint8Array {
    const parts = this.sent.filter((x): x is Uint8Array => x instanceof Uint8Array);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out;
  }

  static reset(): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.script = [];
    FakeWebSocket.failOpen = undefined;
  }
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
