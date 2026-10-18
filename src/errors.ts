/**
 * Ошибки SDK. / SDK errors.
 */

export interface ErrorDetails {
  /** HTTP status (undefined for WebSocket and network errors). */
  status?: number;
  /** Response body as is: parsed JSON, text or bytes. */
  body?: unknown;
  /** Machine-readable error code if the server sent one (e.g. `queue_full`). */
  code?: string;
  cause?: unknown;
}

/** Базовая ошибка API Freedom Speech. / Base error for the Freedom Speech API. */
export class FreedomSpeechError extends Error {
  readonly status?: number;
  readonly body?: unknown;
  readonly code?: string;

  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "FreedomSpeechError";
    this.status = details.status;
    this.body = details.body;
    this.code = details.code;
  }

  toString(): string {
    const parts = [this.message];
    if (this.status !== undefined) parts.push(`HTTP ${this.status}`);
    if (this.code) parts.push(`code=${this.code}`);
    return parts.join(" | ");
  }
}

/** Ключ не принят (401) или не задан. / The API key was rejected (401) or is missing. */
export class AuthenticationError extends FreedomSpeechError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details);
    this.name = "AuthenticationError";
  }
}

/** Сервер прислал кадр `{"type": "error"}` по WebSocket. / Error frame on a WebSocket. */
export class StreamError extends FreedomSpeechError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details);
    this.name = "StreamError";
  }
}

/** Не удалось соединиться или соединение оборвалось. / Network or socket failure. */
export class ConnectionFailed extends FreedomSpeechError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details);
    this.name = "ConnectionFailed";
  }
}

function extractMessage(body: unknown): string {
  if (body && typeof body === "object" && !(body instanceof Uint8Array)) {
    const obj = body as Record<string, unknown>;
    for (const key of ["error", "message", "details"]) {
      const value = obj[key];
      if (typeof value === "string" && value) return value;
    }
    try {
      return JSON.stringify(body);
    } catch {
      return String(body);
    }
  }
  if (body instanceof Uint8Array) {
    try {
      return new TextDecoder().decode(body).slice(0, 300);
    } catch {
      return "<binary>";
    }
  }
  return String(body ?? "").slice(0, 300);
}

/** Собрать исключение по HTTP-коду и телу ответа. / Build an error from an HTTP response. */
export function errorFromResponse(status: number, body: unknown): FreedomSpeechError {
  const detail = extractMessage(body);
  const code =
    body && typeof body === "object" && typeof (body as Record<string, unknown>).code === "string"
      ? ((body as Record<string, unknown>).code as string)
      : undefined;
  if (status === 401) {
    return new AuthenticationError(
      `Ключ не принят: проверьте apiKey или переменную окружения FS_API_KEY (API key was not accepted). Ответ сервера: ${detail}`,
      { status, body, code },
    );
  }
  let msg: string;
  if (status === 400) msg = `Неверный параметр (bad request): ${detail}`;
  else if (status === 402) msg = `Требуется оплата (payment required): ${detail}`;
  else if (status === 403) msg = `Эндпоинт недоступен для этого ключа (endpoint not available for this key): ${detail}`;
  else if (status === 404) msg = `Не найдено (not found): ${detail}`;
  else if (status === 413) msg = `Слишком большой запрос (payload too large): ${detail}`;
  else if (status === 429) msg = `Слишком много запросов (rate limited): ${detail}`;
  else if (status === 502 || status === 503) msg = `Речевой сервис временно недоступен (speech service unavailable): ${detail}`;
  else msg = `Ошибка API (API error): ${detail}`;
  return new FreedomSpeechError(msg, { status, body, code });
}
