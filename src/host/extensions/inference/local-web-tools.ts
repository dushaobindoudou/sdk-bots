/**
 * Local (no-Cursor-credential) implementations of the web tools.
 *
 * In a headless deployment without Cursor credentials every WebSearch/WebFetch
 * call through the Cursor backend fails instantly with a credentials-waiting
 * error — which models then misreport as "network timeout" and retry forever.
 * These services run the work on the host itself: WebFetch does a direct HTTP
 * GET (the tool layer already blocks localhost/private IPs before we see the
 * URL), WebSearch scrapes cn.bing.com's result page. No API keys required.
 */

export interface LocalWebFetchResult {
  readonly content?: string;
  readonly error?: string;
  readonly isTimeout?: boolean;
}

export interface LocalSearchDocument {
  readonly url: string;
  readonly title: string;
  readonly text: string;
}

const FETCH_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 50_000;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Some public data endpoints 403 requests without a same-site Referer (e.g. sina quotes). */
const HOST_EXTRA_HEADERS: ReadonlyArray<{ readonly match: (host: string) => boolean; readonly headers: Record<string, string> }> = [
  { match: (host) => host.endsWith(".sinajs.cn") || host.endsWith(".sina.com.cn"), headers: { referer: "https://finance.sina.com.cn" } },
];

export function createLocalWebFetchService(fetcher: typeof fetch = fetch) {
  return async (_ctx: unknown, url: string): Promise<LocalWebFetchResult> => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: `Invalid URL: ${url.slice(0, 200)}` };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return { error: `Only http(s) URLs are supported (got ${parsed.protocol})` };
    const extra = HOST_EXTRA_HEADERS.find((rule) => rule.match(parsed.hostname))?.headers ?? {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetcher(parsed.toString(), {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": BROWSER_UA,
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          ...extra,
        },
      });
      const raw = await response.text();
      if (!response.ok && raw.trim().length === 0) {
        console.info(`[sdk-bots] web fetch ${parsed.hostname} -> HTTP ${response.status} (empty)`);
        return { error: `HTTP ${response.status} for ${parsed.hostname}` };
      }
      const body = parsed.pathname.endsWith(".json") || response.headers.get("content-type")?.includes("json")
        ? raw
        : htmlToReadableText(raw);
      console.info(`[sdk-bots] web fetch ${parsed.hostname}${parsed.pathname.slice(0, 40)} -> ${response.status}, ${body.length} chars`);
      return { content: body.slice(0, MAX_TEXT_CHARS) };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      console.info(`[sdk-bots] web fetch ${parsed.hostname} -> ${aborted ? "timeout" : "error"}: ${error instanceof Error ? error.message : String(error)}`);
      return {
        error: aborted
          ? `Local fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${parsed.hostname}`
          : `Local fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        isTimeout: aborted,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createLocalWebSearchService(fetcher: typeof fetch = fetch) {
  return async (_ctx: unknown, args: { searchTerm: string; explanation?: string }): Promise<{ answer: string; documents: LocalSearchDocument[] }> => {
    const term = args.searchTerm.trim();
    if (term.length === 0) return { answer: "", documents: [] };
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(term)}&count=10`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetcher(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": BROWSER_UA,
          "accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
      if (!response.ok) {
        console.info(`[sdk-bots] web search "${term.slice(0, 50)}" -> HTTP ${response.status}`);
        throw new Error(`Local search backend HTTP ${response.status}`);
      }
      const documents = parseBingResults(await response.text());
      if (documents.length === 0) {
        console.info(`[sdk-bots] web search "${term.slice(0, 50)}" -> no results parsed`);
        throw new Error(`Local search returned no results for "${term.slice(0, 80)}"`);
      }
      console.info(`[sdk-bots] web search "${term.slice(0, 50)}" -> ${documents.length} results (top: ${documents[0]?.url.slice(0, 60)})`);
      return {
        answer: documents.slice(0, 3).map((doc) => doc.title).join(" / "),
        documents,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError")
        throw new Error(`Local search timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Extract result blocks from a cn.bing.com SERP. Pure — unit-tested. */
export function parseBingResults(html: string, limit = 8): LocalSearchDocument[] {
  const documents: LocalSearchDocument[] = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    const anchor = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/m.exec(block);
    if (anchor == null) continue;
    const url = decodeEntities(anchor[1] ?? "").trim();
    const title = decodeEntities(stripTags(anchor[2] ?? "")).trim();
    if (url.length === 0 || !/^https?:\/\//i.test(url) || title.length === 0) continue;
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/m.exec(block);
    const text = decodeEntities(stripTags(snippet?.[1] ?? "")).trim();
    documents.push({ url, title, text });
    if (documents.length >= limit) break;
  }
  return documents;
}

/** Minimal HTML → readable text. Pure — unit-tested. */
export function htmlToReadableText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return text.trim().slice(0, MAX_TEXT_CHARS);
}

export function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ldquo: "“", rdquo: "”", middot: "·" };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => named[name.toLowerCase()] ?? whole);
}

function safeFromCodePoint(codePoint: number): string {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}
