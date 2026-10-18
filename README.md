# freedomspeech

JavaScript/TypeScript SDK для API [Freedom Speech](https://freedomspeech.kz): распознавание и синтез казахской, русской и английской речи, клонирование голоса, перевод. Документация API: <https://freedomspeech.kz/docs>.

JavaScript/TypeScript SDK for the [Freedom Speech](https://freedomspeech.kz) API: Kazakh, Russian and English speech recognition and synthesis, voice cloning, translation. API reference: <https://freedomspeech.kz/docs>. English section below.

Работает в Node 18+ и в браузере. ESM и CommonJS, типы в комплекте. Зависимостей нет; для WebSocket в Node 18 и 20 нужен пакет `ws` (в Node 22+ и в браузере используется встроенный WebSocket).

```bash
npm install freedomspeech
npm install ws            # только Node 18 и 20, для потоковых методов
export FS_API_KEY=...     # ключ выдаётся через форму на сайте
```

## Быстрый старт

Распознать файл (Node):

```ts
import { FreedomSpeech } from "freedomspeech";

const fs = new FreedomSpeech();                    // ключ из FS_API_KEY
const result = await fs.transcribe("call.mp3");
console.log(result.text);
```

Озвучить текст и сохранить WAV (Node):

```ts
import { writeFile } from "node:fs/promises";
import { FreedomSpeech } from "freedomspeech";

const fs = new FreedomSpeech({ apiKey: process.env.FS_API_KEY });
const wav = await fs.speak("Сәлеметсіз бе, бұл сынақ.", { voice: "tomiris", language: "kk" });
await writeFile("hello.wav", wav);
```

Клонировать голос по записи:

```ts
const wav = await fs.cloneVoice("Сәлеметсіз бе, қалыңыз қалай?", { referenceAudio: "me.wav", language: "kk" });
```

Перевести:

```ts
const [t] = await fs.translate("Привет, мир", "kk");
console.log(t.text, t.detectedSourceLanguage);   // "Сәлем, әлем" "ru"
```

CommonJS:

```js
const { FreedomSpeech } = require("freedomspeech");
```

## В браузере

Ключ API в браузере виден пользователю. Для публичных страниц прокидывайте запросы через свой сервер и держите ключ там; прямой вызов из браузера годится для внутренних инструментов и прототипов.

```html
<script type="module">
  import { FreedomSpeech, pcm16ToWav, concatBytes } from "https://cdn.jsdelivr.net/npm/freedomspeech@0.1.0/dist/index.js";

  const fs = new FreedomSpeech({ apiKey: "<ключ>" });

  // распознать файл из <input type="file">
  document.querySelector("#file").addEventListener("change", async (e) => {
    const { text } = await fs.transcribe(e.target.files[0]);
    console.log(text);
  });

  // озвучить и проиграть
  const wav = await fs.speak("Сәлем", { voice: "tomiris" });
  new Audio(URL.createObjectURL(new Blob([wav], { type: "audio/wav" }))).play();

  // потоковый синтез по WebSocket, модель flash
  const chunks = [];
  for await (const pcm of fs.streamSpeech("Сәлем, Айгерім!", { voice: "tomiris" })) chunks.push(pcm);
  const blob = new Blob([pcm16ToWav(concatBytes(chunks))], { type: "audio/wav" });
</script>
```

Запись с микрофона: `/ws/asr` принимает только PCM16 16 кГц моно. В браузере возьмите `AudioContext({ sampleRate: 16000 })` и `AudioWorklet`, переводите Float32 в Int16 и отдавайте кадры в `ASRStream.send()` (пример в разделе «Поток с микрофона»).

## Что умеет

| Метод | Эндпоинт | Что возвращает |
|---|---|---|
| `transcribe(audio, { prettify, diarize, speakerNames, language })` | `POST /v1/audio/transcriptions` | `Transcription`: `text`, `duration`, `processingTime`, `language`, `segments` |
| `streamTranscribe(pcm16Chunks, { realtime, prettify })` | `WS /ws/asr` | async-генератор `TranscriptEvent` (`partial` / `final`) |
| `asrStream()` | `WS /ws/asr` | `ASRStream` с `send`, `stop`, `recv`, `poll`, `events` для живого микрофона |
| `speak(text, { voice, language, emotion })` | `POST /v1/audio/speech` | `Uint8Array` с WAV, 16 бит, моно, 24 кГц |
| `streamSpeech(text, { voice, model })` | `WS /ws/tts` | async-генератор кусков PCM16 24 кГц |
| `ttsStream()` | `WS /ws/tts` | `TTSStream`: несколько `synthesize` на одном соединении, `cancel` |
| `cloneVoice(text, { referenceAudio или voiceId, speed, duration })` | `POST /api/voice-clone` | `Uint8Array` с WAV |
| `cloneVoiceVariants(text, {...})` | `POST /api/voice-clone?variants=all` | массив `CloneVariant { engine, wav }` |
| `designVoice(text, instruct, { language })` | `POST /api/voice-design` | `VoiceDesign`: `referenceWav`, `variants` |
| `voices()`, `voicePreview(id)` | `GET /api/voices`, `GET /api/voices/{id}/preview` | массив `Voice`, `Uint8Array` с WAV |
| `translate(text, targetLang, { sourceLang })` | `POST /v2/translate` | массив `Translation` |
| `detectLanguage(text)`, `languages()` | `POST /v2/detect`, `GET /v2/languages` | массив `Detection`, объект |
| `health()` | `GET /api/asr/health` | объект |

Аудио на вход (`transcribe`, `referenceAudio`): `Blob`/`File`, `ArrayBuffer`, `Uint8Array`/`Buffer` или путь к файлу (только Node). Вспомогательное: `pcm16ToWav`, `wavToPcm16`, `pcm16Frames`, `concatBytes`, `silence`, константы `ASR_SAMPLE_RATE` (16000) и `TTS_SAMPLE_RATE` (24000).

## Подробнее

### Клиент

```ts
const fs = new FreedomSpeech({
  apiKey: undefined,                       // или FS_API_KEY (Node)
  baseUrl: "https://freedomspeech.kz",
  timeoutMs: 60_000,
  bearerAuth: false,                       // дополнительно слать Authorization: Bearer
  fetch: undefined,                        // своя реализация fetch
  webSocket: undefined,                    // свой конструктор WebSocket
});
```

HTTP-запросы идут с заголовком `X-API-Key`, WebSocket открывается с `?apiKey=`. Флаг `bearerAuth: true` дополнительно добавляет `Authorization: Bearer`; публичная документация описывает только `X-API-Key`, флаг нужен для прокси. Публичные вызовы `voices()`, `languages()`, `health()` работают без ключа.

В Node SDK ищет пакет `ws` и, если он есть, использует его (он умеет передавать заголовки, в том числе `User-Agent`); иначе берёт встроенный `WebSocket` (Node 22+). В браузере всегда встроенный. Если в Node 22+ без `ws` рукопожатие WebSocket падает с 403 (защита перед API проверяет `User-Agent`; на встроенном WebSocket это не проверялось), поставьте `ws`.

### Распознавание с говорящими

```ts
const r = await fs.transcribe("call.wav", { diarize: true, speakerNames: ["Оператор", "Клиент"] });
for (const seg of r.segments) console.log(seg.start?.toFixed(1), seg.speaker, seg.text);
```

Для замеров WER передавайте `prettify: false`: сервер не будет приводить числа и даты к цифрам.

### Поток с микрофона

На вход `/ws/asr` идёт только сырой PCM16: 16 кГц, моно, little-endian, без контейнера. Сервер не пересэмплирует и не распаковывает WAV, MP3 или WebM; неверный формат даёт пустой текст без ошибки. Конвертация файла: `ffmpeg -i in.mp3 -ar 16000 -ac 1 -f s16le out.pcm`.

Файл целиком через поток (Node):

```ts
import { readFile } from "node:fs/promises";
import { FreedomSpeech, pcm16Frames } from "freedomspeech";

const pcm = await readFile("speech.pcm");
const parts: string[] = [];
for await (const ev of fs.streamTranscribe(pcm16Frames(pcm, 100), { realtime: true })) {
  if (ev.isFinal) parts.push(ev.text);
}
console.log(parts.join(" "));
```

Живой микрофон в браузере:

```ts
const stream = await fs.asrStream();
(async () => {
  for await (const ev of stream.events()) console.log(ev.isFinal ? "final" : "partial", ev.text);
})();

const ctx = new AudioContext({ sampleRate: 16000 });
const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
await ctx.audioWorklet.addModule("pcm16-worklet.js");    // переводит Float32 в Int16 и шлёт port.postMessage(int16.buffer)
const node = new AudioWorkletNode(ctx, "pcm16");
node.port.onmessage = (e) => stream.send(e.data);
ctx.createMediaStreamSource(mic).connect(node);

// по кнопке «стоп» для фразы:
stream.stop();           // придёт final, сокет остаётся открытым
```

Длинную речь сервер режет на отрезки по паузам и присылает `final` на каждый: итоговый текст собирается из всех `final`. Для диалога держите один `ASRStream` на всю сессию: после каждой фразы вызывайте `stop()`, забирайте `final` и продолжайте слать звук по тому же соединению. Соединение закрывается сервером после 15 с без аудио.

### Поток синтеза

```ts
import { FreedomSpeech, pcm16ToWav, concatBytes } from "freedomspeech";

const chunks: Uint8Array[] = [];
for await (const pcm of fs.streamSpeech("Сәлем, Айгерім!", { voice: "tomiris", model: "freedomspeech-flash" })) chunks.push(pcm);
await writeFile("hi.wav", pcm16ToWav(concatBytes(chunks)));
```

Две модели: `freedomspeech` (по умолчанию на сервере; синтезирует фразу целиком и отдаёт кусками) и `freedomspeech-flash` (звук идёт по мере синтеза; неречевые теги и эмоции у flash пока не подключены). По HTTP `speak()` работает модель `freedomspeech`; flash доступна по WebSocket.

Для чата или ассистента откройте одно соединение на сессию: первый запрос на новом сокете медленнее. На одном соединении до 8 запросов в очереди и до 60 с ожидания; при переполнении приходит `StreamError` с `code === "queue_full"`.

```ts
const s = await fs.ttsStream();
for (const sentence of sentences) {
  for await (const pcm of s.synthesize(sentence, "tomiris", { model: "freedomspeech-flash" })) play(pcm);
}
s.close();
```

### Теги в тексте

Просодия для всех голосов: `<pause>`, `<louder>...</louder>`, `<slower>...</slower>` (вложенные теги закрываются по порядку). Неречевые звуки только у `tomiris`: `<sigh>`, `<laugh>`, `<cough>` и другие. Незакрытый тег даёт `400`.

### Ошибки

Все ошибки наследуют `FreedomSpeechError` с полями `status` (HTTP-код), `body` (тело ответа), `code` (машинный код, если есть). `AuthenticationError` при 401 и когда ключ не задан; `StreamError` приходит с кадром `{"type": "error"}` по WebSocket; `ConnectionFailed` при сетевых сбоях и таймаутах.

```ts
import { FreedomSpeech, AuthenticationError, FreedomSpeechError } from "freedomspeech";

try {
  await new FreedomSpeech({ apiKey: "bad" }).speak("Сәлем");
} catch (e) {
  if (e instanceof AuthenticationError) console.error(e.message);        // Ключ не принят ... HTTP 401
  else if (e instanceof FreedomSpeechError) console.error(e.status, e.body);
}
```

Коды, которые стоит обрабатывать отдельно: 401 ключ не принят, 402 требуется оплата, 413 слишком большой файл, 429 слишком много запросов, 500 и 502/503 сбой речевого сервиса.

### Лимиты по документации

- Текст синтеза: 2000 символов у демо-ключа сайта; для выданных ключей лимит согласуется при выдаче.
- Референс для клонирования: рекомендуется до 20 с; WAV, MP3, OGG, M4A, FLAC, WebM.
- Форматы файла распознавания: wav, mp3, ogg, oga, m4a, flac, webm, mp4, opus.
- Перевод и определение языка: до 50 строк за запрос.

## English

### Install

```bash
npm install freedomspeech
npm install ws            # Node 18 and 20 only, for the streaming methods
export FS_API_KEY=...
```

Node 18+ (global `fetch`), browsers, ESM and CommonJS, TypeScript types included. No runtime dependencies; `ws` is an optional peer dependency used in Node when present (Node 22+ and browsers have a built-in WebSocket). If the WebSocket handshake fails with 403 on Node 22+ without `ws`, install `ws`: it lets the SDK send its `User-Agent` header (behaviour with the built-in WebSocket is not verified against the production edge).

### Node

```ts
import { writeFile } from "node:fs/promises";
import { FreedomSpeech, pcm16ToWav, concatBytes, pcm16Frames } from "freedomspeech";

const fs = new FreedomSpeech();                                   // key from FS_API_KEY

const { text } = await fs.transcribe("call.mp3");                 // path, Buffer, Blob or ArrayBuffer
const wav = await fs.speak("Сәлеметсіз бе", { voice: "tomiris", language: "kk" });
await writeFile("hello.wav", wav);

const cloned = await fs.cloneVoice("Hello there", { referenceAudio: "me.wav", language: "en" });

const [t] = await fs.translate("Привет, мир", "kk");              // t.text, t.detectedSourceLanguage

// streaming synthesis over WebSocket (flash model by default)
const chunks: Uint8Array[] = [];
for await (const pcm of fs.streamSpeech("Сәлем, Айгерім!", { voice: "tomiris" })) chunks.push(pcm);
await writeFile("hi.wav", pcm16ToWav(concatBytes(chunks)));

// streaming recognition: raw PCM16, 16 kHz, mono, no container
for await (const ev of fs.streamTranscribe(pcm16Frames(await readFile("speech.pcm")), { realtime: true })) {
  if (ev.isFinal) console.log(ev.text);
}
```

### Browser

The API key is visible to the page's user; for public sites proxy the calls through your own backend. Direct calls are fine for internal tools and prototypes.

```ts
import { FreedomSpeech, pcm16ToWav, concatBytes } from "freedomspeech";

const fs = new FreedomSpeech({ apiKey });

const file = (document.querySelector("#file") as HTMLInputElement).files![0];
const { text } = await fs.transcribe(file);                        // Blob / File

const wav = await fs.speak("Hello", { voice: "tomiris", language: "en" });
new Audio(URL.createObjectURL(new Blob([wav], { type: "audio/wav" }))).play();

// live microphone: feed Int16 16 kHz frames from an AudioWorklet
const stream = await fs.asrStream();
node.port.onmessage = (e) => stream.send(e.data);                  // ArrayBuffer of PCM16
for await (const ev of stream.events()) if (ev.isFinal) console.log(ev.text);
```

### Notes

- Authentication: `X-API-Key` header for HTTP, `?apiKey=` for WebSocket. The key comes from `apiKey` or the `FS_API_KEY` environment variable (Node). `bearerAuth: true` adds `Authorization: Bearer` on top (not part of the public docs; useful behind proxies). `voices()`, `languages()`, `health()` need no key.
- `transcribe(..., { diarize: true, speakerNames: [...] })` requests `response_format=diarized_json` and returns `segments` with `speaker`, `start`, `end`. Use `prettify: false` for raw output when measuring WER.
- `streamTranscribe(chunks)` streams raw PCM16 (16 kHz, mono, little-endian) over `WS /ws/asr` and yields `partial` and `final` events. The server does not resample or unwrap containers; convert first (`ffmpeg -i in.mp3 -ar 16000 -ac 1 -f s16le out.pcm`). Long speech is split into segments, one `final` per segment. The server closes the socket after 15 s without audio.
- `speak()` returns a WAV file (16-bit, mono, 24 kHz) as `Uint8Array`. `streamSpeech()` yields raw PCM16 chunks over `WS /ws/tts`; the default model there is `freedomspeech-flash`. Wrap chunks with `pcm16ToWav(concatBytes(chunks))`.
- `ttsStream()` keeps one socket open for many requests (up to 8 queued, 60 s max wait); the first request on a fresh socket is slower. `cancel()` drops the current request and the queue.
- Errors derive from `FreedomSpeechError` (`status`, `body`, `code`); `AuthenticationError` on 401, `StreamError` for WebSocket error frames, `ConnectionFailed` for network failures and timeouts. Status codes worth handling: 401, 402, 413, 429, 500, 502/503.

## Разработка / Development

```bash
npm install
npm run typecheck
npm run build        # tsup: dist/index.js (ESM), dist/index.cjs, dist/index.d.ts
npm test             # vitest, без сети: fetch и WebSocket подменены моками плюс локальный сервер
```

License: MIT.
