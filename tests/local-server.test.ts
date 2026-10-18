/**
 * Проверка против настоящих реализаций: локальный WebSocket-сервер (пакет ws) и HTTP-сервер Node,
 * клиент через пакет `ws` и через встроенный WebSocket Node 22. Сети наружу нет.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket as WsPackage } from "ws";

import { FreedomSpeech, concatBytes, pcm16Frames, silence, type WebSocketCtor } from "../src/index.js";
import { collect } from "./fakes.js";

let http: Server;
let wss: WebSocketServer;
let port: number;
const seenHeaders: Record<string, string | string[] | undefined>[] = [];

beforeAll(async () => {
  http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/api/asr/health") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "healthy", key: req.headers["x-api-key"] ?? null }));
      } else if (req.url === "/v1/audio/transcriptions") {
        const body = Buffer.concat(chunks).toString("latin1");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ text: body.includes('name="file"; filename="a.wav"') ? "ok" : "no file", language: "kk" }));
      } else if (req.url === "/v1/audio/speech") {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "TTS failed" }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  wss = new WebSocketServer({ server: http });
  wss.on("connection", (sock, req) => {
    seenHeaders.push(req.headers as Record<string, string>);
    const url = new URL(req.url ?? "/", "http://x");
    if (url.searchParams.get("apiKey") !== "k") {
      sock.close(1008, "bad key");
      return;
    }
    if (url.pathname === "/ws/asr") {
      sock.send(JSON.stringify({ type: "ready" }));
      let bytes = 0;
      sock.on("message", (data, isBinary) => {
        if (isBinary) {
          bytes += (data as Buffer).length;
          sock.send(JSON.stringify({ type: "partial", text: `bytes=${bytes}` }));
        } else if (JSON.parse(String(data)).type === "stop") {
          sock.send(JSON.stringify({ type: "final", text: `total=${bytes}`, language: "kk" }));
        }
      });
    } else if (url.pathname === "/ws/tts") {
      sock.on("message", (data) => {
        const req = JSON.parse(String(data));
        if (req.type !== "synthesize") return;
        const pcm = Buffer.from(req.text, "utf8");
        sock.send(JSON.stringify({ type: "audio_chunk", requestId: req.requestId, audio: pcm.toString("base64"), chunkIndex: 0, sampleRate: 24000, format: "int16" }));
        sock.send(JSON.stringify({ type: "audio_end", requestId: req.requestId, totalChunks: 1, sampleRate: 24000 }));
      });
    }
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  port = (http.address() as { port: number }).port;
});

afterAll(async () => {
  wss.close();
  await new Promise<void>((r) => http.close(() => r()));
});

function makeClient(impl?: WebSocketCtor): FreedomSpeech {
  return new FreedomSpeech({ apiKey: "k", baseUrl: `http://127.0.0.1:${port}`, webSocket: impl, timeoutMs: 5000 });
}

describe("real HTTP through global fetch", () => {
  it("health and multipart transcribe reach the server", async () => {
    const fs = makeClient();
    expect(await fs.health()).toEqual({ status: "healthy", key: null }); // публичный путь, без ключа
    const r = await fs.transcribe(new Uint8Array([1, 2, 3, 4]), { filename: "a.wav" });
    expect(r.text).toBe("ok");
    const err = await fs.speak("x").catch((e) => e);
    expect(err.status).toBe(500);
    expect(err.message).toContain("TTS failed");
  });
});

const impls: Array<[string, WebSocketCtor | undefined]> = [
  ["ws package (auto)", undefined],
  ["ws package (explicit)", WsPackage as unknown as WebSocketCtor],
];
if (typeof globalThis.WebSocket === "function") impls.push(["global WebSocket (Node 22+)", globalThis.WebSocket as unknown as WebSocketCtor]);

describe.each(impls)("real WebSocket via %s", (_name, impl) => {
  it("ASR streaming roundtrip", async () => {
    const pcm = silence(300);
    const events = await collect(makeClient(impl).streamTranscribe(pcm16Frames(pcm, 100)));
    expect(events.filter((e) => e.isFinal).map((e) => e.text)).toEqual(["total=9600"]);
    expect(events.filter((e) => !e.isFinal)).toHaveLength(3);
  });

  it("TTS streaming roundtrip", async () => {
    const chunks = await collect(makeClient(impl).streamSpeech("hello", { voice: "tomiris" }));
    expect(Buffer.from(concatBytes(chunks)).toString()).toBe("hello");
  });

  it("rejected key closes the socket before ready", async () => {
    const fs = new FreedomSpeech({ apiKey: "bad", baseUrl: `http://127.0.0.1:${port}`, webSocket: impl, timeoutMs: 3000 });
    await expect(fs.asrStream()).rejects.toThrow(/closed|1008/);
  });
});

it("User-Agent header is sent when the ws package is used", () => {
  const ua = seenHeaders.map((h) => String(h["user-agent"] ?? ""));
  expect(ua.some((u) => u.includes("freedomspeech-js"))).toBe(true);
});
