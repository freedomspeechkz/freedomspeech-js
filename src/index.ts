/**
 * freedomspeech: JavaScript/TypeScript SDK для API Freedom Speech (казахская, русская и английская речь).
 * JavaScript/TypeScript SDK for the Freedom Speech API: speech recognition, synthesis, voice cloning, translation.
 *
 * ```ts
 * import { FreedomSpeech } from "freedomspeech";
 * const fs = new FreedomSpeech();                 // ключ из FS_API_KEY
 * console.log((await fs.transcribe("call.mp3")).text);
 * ```
 *
 * Документация API: https://freedomspeech.kz/docs
 */
export { VERSION } from "./version.js";
export {
  FreedomSpeech,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  ENV_API_KEY,
  ENV_BASE_URL,
} from "./client.js";
export type {
  AudioInput,
  CloneVoiceOptions,
  DesignVoiceOptions,
  FetchLike,
  FreedomSpeechOptions,
  SpeakOptions,
  StreamSpeechOptions,
  TranscribeOptions,
  TranslateOptions,
} from "./client.js";
export { FreedomSpeechError, AuthenticationError, StreamError, ConnectionFailed } from "./errors.js";
export type { ErrorDetails } from "./errors.js";
export type {
  CloneVariant,
  Detection,
  Json,
  Segment,
  Transcription,
  TranscriptEvent,
  Translation,
  Voice,
  VoiceDesign,
} from "./models.js";
export { ASRStream, TTSStream } from "./streaming.js";
export type { StreamTranscribeOptions, SynthesizeOptions, WSConnect, WSLike, WebSocketCtor } from "./streaming.js";
export {
  ASR_SAMPLE_RATE,
  TTS_SAMPLE_RATE,
  base64ToBytes,
  bytesToBase64,
  concatBytes,
  isWav,
  parseWav,
  pcm16Duration,
  pcm16Frames,
  pcm16ToWav,
  silence,
  toBytes,
  wavDuration,
  wavToPcm16,
} from "./audio.js";
export type { BinaryInput, WavInfo } from "./audio.js";
