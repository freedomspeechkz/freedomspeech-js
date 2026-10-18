/** HTTP-методы клиента с поддельным fetch. / HTTP client methods against a fake fetch. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthenticationError, ConnectionFailed, FreedomSpeech, FreedomSpeechError, bytesToBase64, pcm16ToWav } from "../src/index.js";
import { FakeFetch } from "./fakes.js";

const WAV = pcm16ToWav(new Uint8Array(4800), 24000);

let ff: FakeFetch;
let client: FreedomSpeech;

beforeEach(() => {
  delete process.env.FS_API_KEY;
  delete process.env.FS_BASE_URL;
  ff = new FakeFetch();
  client = new FreedomSpeech({ apiKey: "test-key", fetch: ff.fetch });
});

afterEach(() => {
  delete process.env.FS_API_KEY;
  delete process.env.FS_BASE_URL;
});

async function formEntries(form: FormData | undefined): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [k, v] of form!.entries()) {
    (out[k] ??= []).push(v);
  }
  return out;
}

describe("key and headers", () => {
  it("takes key from env", async () => {
    process.env.FS_API_KEY = "env-key";
    const fs = new FreedomSpeech({ fetch: ff.fetch });
    expect(fs.apiKey).toBe("env-key");
    ff.bytes(200, WAV);
    await fs.speak("Сәлем");
    expect(ff.last.headers["X-API-Key"]).toBe("env-key");
    expect(ff.last.headers.Authorization).toBeUndefined();
    expect(ff.last.headers["User-Agent"]).toContain("freedomspeech-js");
  });

  it("bearer flag adds Authorization", async () => {
    const fs = new FreedomSpeech({ apiKey: "k", fetch: ff.fetch, bearerAuth: true });
    ff.bytes(200, WAV);
    await fs.speak("Сәлем");
    expect(ff.last.headers["X-API-Key"]).toBe("k");
    expect(ff.last.headers.Authorization).toBe("Bearer k");
  });

  it("missing key raises before request", async () => {
    const fs = new FreedomSpeech({ fetch: ff.fetch });
    await expect(fs.speak("Сәлем")).rejects.toBeInstanceOf(AuthenticationError);
    expect(ff.calls).toHaveLength(0);
  });

  it("public endpoints work without key", async () => {
    const fs = new FreedomSpeech({ fetch: ff.fetch });
    ff.json(200, [{ id: "tomiris", name: "Tomiris", type: "builtin" }]);
    const voices = await fs.voices();
    expect(voices[0].id).toBe("tomiris");
    expect(voices[0].type).toBe("builtin");
    expect(ff.last.headers["X-API-Key"]).toBeUndefined();
    expect(ff.last.url).toBe("https://freedomspeech.kz/api/voices");
  });

  it("voices accepts wrapped list", async () => {
    ff.json(200, { voices: [{ id: "alikhan_kz", name: "Alikhan", type: "custom" }] });
    const voices = await client.voices();
    expect(voices).toHaveLength(1);
    expect(voices[0].name).toBe("Alikhan");
  });

  it("base url and ws url", () => {
    const fs = new FreedomSpeech({ apiKey: "k", baseUrl: "https://example.test/", fetch: ff.fetch });
    expect(fs.baseUrl).toBe("https://example.test");
    expect(fs.wsBaseUrl).toBe("wss://example.test");
    const http = new FreedomSpeech({ apiKey: "k", baseUrl: "http://localhost:8000", fetch: ff.fetch });
    expect(http.wsBaseUrl).toBe("ws://localhost:8000");
  });
});

describe("errors", () => {
  it("401 becomes AuthenticationError with body", async () => {
    ff.json(401, { error: "Invalid or missing API key" });
    const err = await client.speak("Сәлем").catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.status).toBe(401);
    expect(String(err)).toContain("Ключ не принят");
    expect(String(err)).toContain("FS_API_KEY");
    expect(err.body).toEqual({ error: "Invalid or missing API key" });
  });

  it("error body, code and status mapping", async () => {
    ff.json(502, { error: "Voice cloning failed", details: "Voice service is temporarily unavailable" });
    const err = await client.cloneVoice("text", { voiceId: "alikhan_kz" }).catch((e) => e);
    expect(err).toBeInstanceOf(FreedomSpeechError);
    expect(err.status).toBe(502);
    expect(err.message).toContain("Voice cloning failed");
    expect(err.body.details).toMatch(/^Voice service/);

    for (const [status, word] of [
      [402, "payment required"],
      [413, "payload too large"],
      [429, "rate limited"],
      [400, "bad request"],
      [500, "API error"],
    ] as const) {
      ff.json(status, { error: "x", code: "some_code" });
      const e = await client.health().catch((e) => e);
      expect(e.status).toBe(status);
      expect(e.code).toBe("some_code");
      expect(e.message).toContain(word);
    }
  });

  it("non-JSON error body", async () => {
    ff.text(500, "<html>boom</html>");
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(FreedomSpeechError);
    expect(err.status).toBe(500);
    expect(err.message).toContain("boom");
  });

  it("network error becomes ConnectionFailed", async () => {
    const fs = new FreedomSpeech({
      apiKey: "k",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(fs.voices()).rejects.toBeInstanceOf(ConnectionFailed);
  });

  it("timeout becomes ConnectionFailed", async () => {
    const fs = new FreedomSpeech({
      apiKey: "k",
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    });
    const err = await fs.voices().catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionFailed);
    expect(err.message).toContain("timed out");
  });

  it("non-JSON success body", async () => {
    ff.text(200, "not json");
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(FreedomSpeechError);
    expect(err.message).toContain("non-JSON");
  });
});

describe("transcribe", () => {
  it("sends multipart from bytes", async () => {
    ff.json(200, { text: "Сәлем", duration: 1.5, processingTime: 0.4, language: "kk" });
    const r = await client.transcribe(new Uint8Array([82, 73, 70, 70]), { filename: "a.wav" });
    expect(r.text).toBe("Сәлем");
    expect(r.duration).toBe(1.5);
    expect(r.processingTime).toBe(0.4);
    expect(r.language).toBe("kk");
    expect(r.segments).toEqual([]);
    expect(ff.last.method).toBe("POST");
    expect(ff.last.url).toBe("https://freedomspeech.kz/v1/audio/transcriptions");
    expect(ff.last.headers["Content-Type"]).toBeUndefined(); // boundary ставит fetch
    const f = await formEntries(ff.last.form);
    const file = f.file[0] as File;
    expect(file.name).toBe("a.wav");
    expect(file.type).toBe("audio/wav");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]));
    expect(f.prettify).toEqual(["true"]);
    expect(f.response_format).toBeUndefined();
  });

  it("file path with diarization options", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-sdk-"));
    const p = join(dir, "call.mp3");
    writeFileSync(p, Buffer.from("ID3abc"));
    ff.json(200, {
      task: "transcribe",
      text: "Agent: a\nClient: b",
      duration: 12.5,
      language: "kk",
      segments: [
        { type: "transcript.text.segment", id: "seg_001", start: 1.128, end: 3.512, text: "a", speaker: "Agent" },
        { type: "transcript.text.segment", id: "seg_002", start: 4.232, end: 11.448, text: "b", speaker: "Client" },
      ],
    });
    const r = await client.transcribe(p, { prettify: false, diarize: true, speakerNames: ["Agent", "Client"] });
    const f = await formEntries(ff.last.form);
    const file = f.file[0] as File;
    expect(file.name).toBe("call.mp3");
    expect(file.type).toBe("audio/mpeg");
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe("ID3abc");
    expect(f.prettify).toEqual(["false"]);
    expect(f.response_format).toEqual(["diarized_json"]);
    expect(f["known_speaker_names[]"]).toEqual(["Agent", "Client"]);
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0].speaker).toBe("Agent");
    expect(r.segments[0].start).toBe(1.128);
    expect(r.segments[1].end).toBe(11.448);
    expect(r.task).toBe("transcribe");
  });

  it("Blob/File input with language and model", async () => {
    ff.json(200, { text: "ok" });
    const file = new File([new Uint8Array([79, 103, 103, 83])], "rec.ogg", { type: "audio/ogg" });
    await client.transcribe(file, { language: "ru", model: "whisper-1" });
    const f = await formEntries(ff.last.form);
    expect((f.file[0] as File).name).toBe("rec.ogg");
    expect(f.language).toEqual(["ru"]);
    expect(f.model).toEqual(["whisper-1"]);

    ff.json(200, { text: "ok" });
    await client.transcribe(new Blob([new Uint8Array(4)]));
    const g = await formEntries(ff.last.form);
    expect((g.file[0] as File).name).toBe("audio.wav");
  });

  it("rejects unexpected response shape", async () => {
    ff.json(200, ["not", "an", "object"]);
    await expect(client.transcribe(new Uint8Array(2))).rejects.toBeInstanceOf(FreedomSpeechError);
  });
});

describe("speak", () => {
  it("sends json body and returns WAV bytes", async () => {
    ff.bytes(200, WAV);
    const out = await client.speak("Сәлем <pause> қош келдіңіз", { voice: "Tomiris", language: "kk", emotion: "happy" });
    expect(out).toEqual(WAV);
    expect(ff.last.url).toBe("https://freedomspeech.kz/v1/audio/speech");
    expect(ff.last.headers["Content-Type"]).toBe("application/json");
    expect(ff.last.json).toEqual({ input: "Сәлем <pause> қош келдіңіз", voice: "Tomiris", language: "kk", emotion: "happy" });
  });

  it("optional fields are not sent", async () => {
    ff.bytes(200, WAV);
    await client.speak("Сәлем");
    expect(ff.last.json).toEqual({ input: "Сәлем", voice: "tomiris" });
    ff.bytes(200, WAV);
    await client.speak("Сәлем", { model: "freedomspeech", responseFormat: "wav" });
    expect(ff.last.json).toEqual({ input: "Сәлем", voice: "tomiris", model: "freedomspeech", response_format: "wav" });
  });

  it("empty text", async () => {
    await expect(client.speak("   ")).rejects.toThrow("text is required");
  });
});

describe("voices and cloning", () => {
  it("voice preview", async () => {
    ff.bytes(200, WAV);
    expect(await client.voicePreview("alikhan_kz")).toEqual(WAV);
    expect(ff.last.url.endsWith("/api/voices/alikhan_kz/preview")).toBe(true);
    expect(ff.last.headers["X-API-Key"]).toBeUndefined();
  });

  it("clone from reference bytes", async () => {
    ff.bytes(200, WAV);
    const out = await client.cloneVoice("Сәлеметсіз бе", { referenceAudio: WAV, filename: "me.wav", language: "kk", speed: 1.2 });
    expect(out).toEqual(WAV);
    expect(ff.last.url).toBe("https://freedomspeech.kz/api/voice-clone");
    const f = await formEntries(ff.last.form);
    expect(f.text).toEqual(["Сәлеметсіз бе"]);
    expect(f.language).toEqual(["kk"]);
    expect(f.speed).toEqual(["1.2"]);
    expect(f.voice_id).toBeUndefined();
    const audio = f.audio[0] as File;
    expect(audio.name).toBe("me.wav");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(WAV);
  });

  it("clone from catalog id with duration", async () => {
    ff.bytes(200, WAV);
    await client.cloneVoice("Жаңа маусым", { voiceId: "alikhan_kz", duration: 3.5 });
    const f = await formEntries(ff.last.form);
    expect(f.audio).toBeUndefined();
    expect(f.text).toEqual(["Жаңа маусым"]);
    expect(f.voice_id).toEqual(["alikhan_kz"]);
    expect(f.duration).toEqual(["3.5"]);
  });

  it("requires exactly one source", async () => {
    await expect(client.cloneVoice("text", {})).rejects.toThrow("exactly one");
    await expect(client.cloneVoice("text", { referenceAudio: new Uint8Array(2), voiceId: "tomiris" })).rejects.toThrow("exactly one");
    await expect(client.cloneVoice("", { voiceId: "tomiris" })).rejects.toThrow("text is required");
  });

  it("clone variants", async () => {
    const b64 = bytesToBase64(WAV);
    ff.json(200, {
      variants: [
        { engine: "omnivoice", wav_base64: b64 },
        { engine: "flash", wav_base64: b64 },
      ],
    });
    const variants = await client.cloneVoiceVariants("Сәлем", { referenceAudio: new Uint8Array([1, 2]), filename: "ref.wav" });
    expect(ff.last.url).toBe("https://freedomspeech.kz/api/voice-clone?variants=all");
    expect(variants.map((v) => v.engine)).toEqual(["omnivoice", "flash"]);
    expect(variants[0].wav).toEqual(WAV);
  });

  it("design voice", async () => {
    const b64 = bytesToBase64(WAV);
    ff.json(200, { reference_wav_base64: b64, voice_clone_wav_base64: b64, variants: [{ engine: "flash", wav_base64: b64 }] });
    const d = await client.designVoice("Сәлеметсіз бе", "A calm male voice", { language: "kk" });
    expect(ff.last.url.endsWith("/api/voice-design")).toBe(true);
    expect(ff.last.json).toEqual({ text: "Сәлеметсіз бе", instruct: "A calm male voice", language: "kk" });
    expect(d.referenceWav).toEqual(WAV);
    expect(d.wav).toEqual(WAV);
    expect(d.variants[0].engine).toBe("flash");
    await expect(client.designVoice("text", "")).rejects.toThrow("instruct is required");
  });
});

describe("text and service", () => {
  it("translate", async () => {
    ff.json(200, { translations: [{ detected_source_language: "ru", text: "Сәлем дүние" }] });
    const out = await client.translate("Привет мир", "kk");
    expect(ff.last.json).toEqual({ text: "Привет мир", target_lang: "kk" });
    expect(out[0].text).toBe("Сәлем дүние");
    expect(out[0].detectedSourceLanguage).toBe("ru");

    ff.json(200, { translations: [{ text: "Сәлем" }, { text: "Сау бол" }] });
    const many = await client.translate(["Привет", "Пока"], "kk", { sourceLang: "ru" });
    expect(ff.last.json).toEqual({ text: ["Привет", "Пока"], target_lang: "kk", source_lang: "ru" });
    expect(many.map((t) => t.text)).toEqual(["Сәлем", "Сау бол"]);
  });

  it("detect, languages, health", async () => {
    ff.json(200, {
      detections: [
        { detected_source_language: "kk", text: "Сәлем" },
        { detected_source_language: "en", text: "Hello" },
      ],
    });
    const d = await client.detectLanguage(["Сәлем", "Hello"]);
    expect(d.map((x) => x.language)).toEqual(["kk", "en"]);
    expect(ff.last.json).toEqual({ text: ["Сәлем", "Hello"] });

    ff.json(200, { source_languages: [{ language: "kk", name: "Kazakh" }], target_languages: [] });
    const langs = await client.languages();
    expect((langs.source_languages as Array<{ language: string }>)[0].language).toBe("kk");
    expect(ff.last.headers["X-API-Key"]).toBeUndefined();

    ff.json(200, { status: "healthy", vad_pool_ready: true });
    expect((await client.health()).status).toBe("healthy");

    ff.json(503, { status: "unavailable", model_loaded: false });
    const err = await client.health().catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.body.status).toBe("unavailable");
  });
});
