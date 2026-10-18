/** WebSocket-потоки с поддельным сокетом. / Streaming ASR and TTS against a fake socket. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ASR_SAMPLE_RATE,
  AuthenticationError,
  ConnectionFailed,
  FreedomSpeech,
  StreamError,
  TTS_SAMPLE_RATE,
  bytesToBase64,
  concatBytes,
  pcm16Frames,
  pcm16ToWav,
  silence,
  wavToPcm16,
} from "../src/index.js";
import { FakeWebSocket, collect } from "./fakes.js";

function client(): FreedomSpeech {
  return new FreedomSpeech({ apiKey: "k", webSocket: FakeWebSocket, fetch: async () => new Response("") });
}

const ws = () => FakeWebSocket.instances[0];

beforeEach(() => FakeWebSocket.reset());
afterEach(() => FakeWebSocket.reset());

/** Кадр, который сервер присылает только после {"type": "stop"}. */
const afterStop = (s: FakeWebSocket) =>
  s.sent.some((x) => typeof x === "string" && x.includes("stop")) ? { type: "final", text: "қалайсың", language: "kk" } : null;

describe("ASR", () => {
  it("streamTranscribe: events and protocol", async () => {
    FakeWebSocket.script = [
      { type: "ready" },
      { type: "partial", text: "сәлем", is_final: false },
      { type: "final", text: "сәлем әлем", language: "kk" },
      afterStop,
    ];
    const pcm = silence(300); // 300 мс = 9600 байт, 3 кадра по 100 мс
    const t0 = Date.now();
    const events = await collect(client().streamTranscribe(pcm16Frames(pcm, 100), { prettify: false, realtime: true, finalTimeoutMs: 5000 }));
    expect(Date.now() - t0).toBeLessThan(3000); // закончили по final после stop, не по finalTimeout
    expect(ws().url).toBe("wss://freedomspeech.kz/ws/asr?apiKey=k&prettify=false");
    expect(events.map((e) => e.type)).toEqual(["partial", "final", "final"]);
    expect(events[0].isFinal).toBe(false);
    expect(events[1].isFinal).toBe(true);
    expect(events[1].language).toBe("kk");
    expect(ws().sentBytes()).toEqual(pcm);
    expect(ws().sent.filter((x) => x instanceof Uint8Array)).toHaveLength(3);
    expect(ws().sentJson()).toEqual([{ type: "stop" }]);
    expect(ws().closed).toBe(true);
  });

  it("default prettify is not in the URL; async iterable input", async () => {
    FakeWebSocket.script = [{ type: "ready" }];
    async function* frames() {
      yield silence(100);
      yield new Uint8Array(silence(100)).buffer; // ArrayBuffer тоже принимается
    }
    const events = await collect(client().streamTranscribe(frames(), { finalTimeoutMs: 100 }));
    expect(events).toEqual([]);
    expect(ws().url).toBe("wss://freedomspeech.kz/ws/asr?apiKey=k");
    expect(ws().sentBytes().byteLength).toBe(6400);
  });

  it("error frame raises StreamError and closes", async () => {
    FakeWebSocket.script = [{ type: "ready" }, { type: "error", message: "upstream connection failed" }];
    const err = await collect(client().streamTranscribe([silence(100)], { finalTimeoutMs: 100 })).catch((e) => e);
    expect(err).toBeInstanceOf(StreamError);
    expect(err.message).toContain("upstream connection failed");
    expect(ws().closed).toBe(true);
  });

  it("manual ASRStream use", async () => {
    FakeWebSocket.script = [{ type: "ready" }, { type: "partial", text: "а" }, { type: "final", text: "абв", language: "ru" }];
    const s = await client().asrStream();
    expect(s.ready).toBe(true);
    s.send(silence(100));
    s.stop();
    const got = await collect(s.poll(50));
    expect(got.map((g) => g.text)).toEqual(["а", "абв"]);
    expect(ws().sentJson()).toEqual([{ type: "stop" }]);
    expect(await s.recv(10)).toBeNull();
    s.close();
    expect(ws().closed).toBe(true);
  });

  it("events() ends when the server closes", async () => {
    FakeWebSocket.script = [{ type: "ready" }, { type: "final", text: "x" }, { closeWith: 1011 }];
    const s = await client().asrStream();
    const got = await collect(s.events());
    expect(got.map((g) => g.text)).toEqual(["x"]);
  });

  it("odd frame rejected", async () => {
    FakeWebSocket.script = [{ type: "ready" }];
    const s = await client().asrStream();
    expect(() => s.send(new Uint8Array(3))).toThrow(/even number/);
  });

  it("error instead of ready", async () => {
    FakeWebSocket.script = [{ type: "error", message: "bad key" }];
    await expect(client().asrStream()).rejects.toBeInstanceOf(StreamError);
    expect(ws().closed).toBe(true);
  });

  it("closed by server during recv", async () => {
    FakeWebSocket.script = [{ type: "ready" }, { closeWith: 1011 }];
    const s = await client().asrStream();
    await expect(s.recv(1000)).rejects.toBeInstanceOf(ConnectionFailed);
    expect(() => s.send(silence(100))).toThrow(ConnectionFailed);
  });

  it("connect failure is wrapped; 401 becomes AuthenticationError", async () => {
    FakeWebSocket.failOpen = "connect ECONNREFUSED";
    await expect(client().asrStream()).rejects.toBeInstanceOf(ConnectionFailed);
    FakeWebSocket.reset();
    FakeWebSocket.failOpen = "Unexpected server response: 401";
    await expect(client().asrStream()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("custom wsConnect receives headers", async () => {
    FakeWebSocket.script = [{ type: "ready" }];
    let seen: Record<string, string> | undefined;
    const fs = new FreedomSpeech({
      apiKey: "k",
      fetch: async () => new Response(""),
      wsConnect: (url, headers) => {
        seen = headers;
        return new FakeWebSocket(url);
      },
    });
    const s = await fs.asrStream();
    expect(seen?.["User-Agent"]).toContain("freedomspeech-js");
    s.close();
  });
});

const chunk = (rid: string, idx: number, pcm: Uint8Array) => ({
  type: "audio_chunk",
  requestId: rid,
  audio: bytesToBase64(pcm),
  chunkIndex: idx,
  sampleRate: 24000,
  format: "int16",
});

describe("TTS", () => {
  it("streamSpeech collects PCM and sends the request", async () => {
    const a = new Uint8Array(200).fill(1);
    const b = new Uint8Array(100).fill(2);
    FakeWebSocket.script = [
      (s) => (s.sentJson().length ? { type: "text_chunk", requestId: "r1", index: 0 } : null),
      chunk("r1", 0, a),
      chunk("r1", 1, b),
      { type: "audio_end", requestId: "r1", totalChunks: 2, sampleRate: 24000 },
    ];
    const chunks = await collect(client().streamSpeech("Сәлем", { voice: "tomiris", language: "kk", requestId: "r1" }));
    expect(chunks).toEqual([a, b]);
    expect(ws().url).toBe("wss://freedomspeech.kz/ws/tts?apiKey=k");
    expect(ws().sentJson()[0]).toEqual({ type: "synthesize", text: "Сәлем", requestId: "r1", voice: "tomiris", model: "freedomspeech-flash", language: "kk" });
    expect(ws().closed).toBe(true);
    const wav = pcm16ToWav(concatBytes(chunks), TTS_SAMPLE_RATE);
    expect(Array.from(wav.subarray(0, 4))).toEqual([82, 73, 70, 70]);
    expect(wav.byteLength).toBe(44 + a.byteLength + b.byteLength);
  });

  it("ttsStream: several requests, queue error, cancel", async () => {
    FakeWebSocket.script = [
      (s) => (s.sentJson().length >= 1 ? chunk("x", 0, new Uint8Array([0, 1])) : null),
      { type: "audio_end", requestId: "x", totalChunks: 1 },
      (s) => (s.sentJson().length >= 2 ? { type: "error", requestId: "y", code: "queue_full", message: "queue is full" } : null),
    ];
    const s = await client().ttsStream();
    const first = concatBytes(await collect(s.synthesize("бір", "tomiris", { model: "freedomspeech", requestId: "x" })));
    expect(first).toEqual(new Uint8Array([0, 1]));
    expect(s.lastTotalChunks).toBe(1);
    const err = await collect(s.synthesize("екі", "tomiris", { requestId: "y" })).catch((e) => e);
    expect(err).toBeInstanceOf(StreamError);
    expect(err.code).toBe("queue_full");
    s.cancel();
    s.cancel("y");
    s.close();
    const sent = ws().sentJson();
    expect(sent[0].model).toBe("freedomspeech");
    expect(sent[0]).not.toHaveProperty("emotion");
    expect(sent[1]).not.toHaveProperty("model");
    expect(sent[2]).toEqual({ type: "cancel" });
    expect(sent[3]).toEqual({ type: "cancel", requestId: "y" });
    expect(ws().closed).toBe(true);
  });

  it("ignores frames of other requests; cancelled ends without error", async () => {
    FakeWebSocket.script = [
      { type: "cancelled", requestId: "old", totalChunks: 7 },
      (s) => (s.sentJson().length ? chunk("new", 0, new Uint8Array([7, 0])) : null),
      { type: "cancelled", requestId: "new", totalChunks: 1 },
    ];
    const s = await client().ttsStream();
    const out = await collect(s.synthesize("текст", undefined, { requestId: "new" }));
    expect(out).toEqual([new Uint8Array([7, 0])]);
    expect(s.lastTotalChunks).toBe(1);
    expect(ws().sentJson()[0]).not.toHaveProperty("voice");
  });

  it("generated requestId and empty text", async () => {
    FakeWebSocket.script = [(s) => (s.sentJson().length ? { type: "audio_end", requestId: s.sentJson()[0].requestId as string, totalChunks: 0 } : null)];
    const s = await client().ttsStream();
    await collect(s.synthesize("текст"));
    expect(String(ws().sentJson()[0].requestId)).toMatch(/^req-[0-9a-f]{12}$/);
    await expect(collect(s.synthesize(""))).rejects.toThrow("text is required");
  });

  it("server close during synthesize is ConnectionFailed", async () => {
    FakeWebSocket.script = [(s) => (s.sentJson().length ? { closeWith: 1011 } : null)];
    const s = await client().ttsStream();
    await expect(collect(s.synthesize("текст"))).rejects.toBeInstanceOf(ConnectionFailed);
  });
});

describe("audio helpers", () => {
  it("wav roundtrip and frames", () => {
    const pcm = new Uint8Array(2560).map((_, i) => i % 256);
    const wav = pcm16ToWav(pcm, ASR_SAMPLE_RATE);
    expect(wavToPcm16(wav)).toEqual(pcm);
    const frames = [...pcm16Frames(pcm, 10)];
    expect(frames.every((f) => f.byteLength % 2 === 0)).toBe(true);
    expect(concatBytes(frames)).toEqual(pcm);
    expect(() => wavToPcm16(pcm16ToWav(pcm, 24000))).toThrow(/16000 Hz/);
    expect(wavToPcm16(pcm16ToWav(pcm, 24000), 0)).toEqual(pcm);
    expect(silence(100).byteLength).toBe(3200);
  });
});
