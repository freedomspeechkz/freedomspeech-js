# Changelog

## 0.1.0 (2026-10-17)

Первый выпуск. / First release.

- `FreedomSpeech` client: `X-API-Key` auth, key from `FS_API_KEY` (Node), optional `Authorization: Bearer`, custom `fetch` and `WebSocket`.
- `transcribe()`: `POST /v1/audio/transcriptions` with `prettify`, `response_format=diarized_json`, `known_speaker_names[]`; input as file path (Node), `Blob`/`File`, `ArrayBuffer`, `Uint8Array`.
- `streamTranscribe()` and `asrStream()`: `WS /ws/asr`, PCM16 16 kHz frames, `partial` / `final` events, `stop`.
- `speak()`: `POST /v1/audio/speech`, WAV 24 kHz as `Uint8Array`.
- `streamSpeech()` and `ttsStream()`: `WS /ws/tts`, PCM16 chunks, `freedomspeech-flash` by default, queue and cancel.
- `cloneVoice()`, `cloneVoiceVariants()`: `POST /api/voice-clone` (reference audio or `voiceId`, `speed`, `duration`, `?variants=all`).
- `designVoice()`: `POST /api/voice-design`.
- `voices()`, `voicePreview()`: `GET /api/voices`, `GET /api/voices/{id}/preview`.
- `translate()`, `detectLanguage()`, `languages()`: `/v2/translate`, `/v2/detect`, `/v2/languages`.
- `health()`: `GET /api/asr/health`.
- Audio helpers: `pcm16ToWav`, `wavToPcm16`, `pcm16Frames`, `concatBytes`, `silence`, `base64ToBytes`.
- Builds: ESM (`dist/index.js`), CommonJS (`dist/index.cjs`), types (`dist/index.d.ts`). Node 18+, browsers.

## Проверка / Verification, 17.10.2026

Протоколы HTTP и WebSocket повторяют Python SDK `freedomspeech` 0.1.0, который проверен на живом API 18.10.2026 00:30 Алматы. Этот пакет на живом API не запускался: 54 теста vitest без сети (моки `fetch` и `WebSocket`, плюс локальный HTTP/WebSocket-сервер с пакетом `ws` и со встроенным WebSocket Node 22). Публикация в npm после появления аккаунта.

The HTTP and WebSocket protocols mirror the Python SDK `freedomspeech` 0.1.0, verified against the live API on 2026-10-18. This package itself was not run against the live API: 54 vitest tests without network (mocked `fetch` and `WebSocket`, plus a local HTTP/WebSocket server exercised through the `ws` package and the built-in Node 22 WebSocket). npm publication pending an account.

## Живая проверка 18.10.2026 04:00 (Freedom Voice, тестовый ключ, Node 22, dist/index.js)
- health, languages, detectLanguage, translate(text, 'ru'), voices (39), transcribe (wav 4 с, казахский, текст верный), streamSpeech (13 чанков, 94 080 байт), streamTranscribe (/ws/asr, partial приходят): работают.
- speak (POST /v1/audio/speech): FreedomSpeechError «speech service unavailable», известная проблема прода с 15.10, не SDK.
