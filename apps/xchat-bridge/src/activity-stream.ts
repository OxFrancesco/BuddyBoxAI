export type XActivityHttp = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class XActivityStreamClient {
  readonly #baseUrl: string;
  readonly #bearerToken: string;
  readonly #fetcher: XActivityHttp;

  constructor(options: { baseUrl: string; bearerToken: string; fetcher?: XActivityHttp }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#bearerToken = options.bearerToken;
    this.#fetcher = options.fetcher ?? fetch;
  }

  async *events(signal?: AbortSignal, onOpen?: () => void): AsyncGenerator<unknown> {
    const url = new URL(`${this.#baseUrl}/2/activity/stream`);
    url.searchParams.set("backfill_minutes", "5");
    const response = await this.#fetcher(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.#bearerToken}` },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`X Activity stream failed with HTTP ${response.status}`);
    if (!response.body) throw new Error("X Activity stream response has no body");
    onOpen?.();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 1);
          if (!line) continue;
          yield JSON.parse(line) as unknown;
        }
      }
      const tail = `${buffer}${decoder.decode()}`.trim();
      if (tail) yield JSON.parse(tail) as unknown;
    } finally {
      reader.releaseLock();
    }
  }
}
