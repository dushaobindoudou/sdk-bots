import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  createLocalWebFetchService,
  createLocalWebSearchService,
  decodeEntities,
  htmlToReadableText,
  parseBingResults,
} from "../../src/host/extensions/inference/local-web-tools.ts";

const BING_FIXTURE = `
<html><body><ol id="b_results">
<li class="b_algo" data-id iid="SERP.1"><div class="b_tpcn"><a class="tilk">example.com</a></div>
  <h2><a href="https://example.com/nvda" h="ID=SERP,1">NVDA &#x80A1;&#20215; _ 英伟达</a></h2>
  <p>英伟达（NVDA）最新股价 <b>135.2</b> 美元，涨 1.2%。</p></li>
<li class="b_algo" data-id iid="SERP.2">
  <h2><a href="https://news.example.org/story">NVDA news &amp; analysis</a></h2>
  <div><p>Market coverage &mdash; updated today.</p></div></li>
<li class="b_algo" data-id iid="SERP.3">
  <h2><a href="javascript:void(0)">bad protocol skipped</a></h2><p>x</p></li>
<li class="b_algo" data-id iid="SERP.4">
  <div>no h2 anchor here</div></li>
</ol></body></html>`;

describe("parseBingResults", () => {
  test("extracts url/title/snippet and skips malformed blocks", () => {
    const docs = parseBingResults(BING_FIXTURE);
    assert.equal(docs.length, 2);
    assert.equal(docs[0]?.url, "https://example.com/nvda");
    assert.equal(docs[0]?.title, "NVDA 股价 _ 英伟达");
    assert.ok(docs[0]?.text.includes("135.2"));
    assert.equal(docs[1]?.title, "NVDA news & analysis");
  });
  test("honors the limit", () => {
    assert.equal(parseBingResults(BING_FIXTURE, 1).length, 1);
  });
});

describe("htmlToReadableText", () => {
  test("drops scripts/styles, keeps block structure, decodes entities", () => {
    const html = `<html><head><style>.x{color:red}</style><script>alert(1)</script></head>
      <body><h1>Title &amp; more</h1><p>Line&nbsp;one<br/>Line two</p><!-- comment -->
      <div>Tail</div></body></html>`;
    const text = htmlToReadableText(html);
    assert.ok(!text.includes("color:red"));
    assert.ok(!text.includes("alert"));
    assert.ok(!text.includes("comment"));
    assert.ok(text.includes("Title & more"));
    assert.ok(text.includes("Line one\nLine two"));
    assert.ok(text.includes("Tail"));
  });
});

describe("decodeEntities", () => {
  test("numeric, hex, and named entities", () => {
    assert.equal(decodeEntities("&#x4E2D;&#25991; &amp; &quot;qi&quot; &nbsp;X"), '中文 & "qi"  X');
  });
});

describe("local web fetch service", () => {
  test("returns readable text for html and reports errors", async () => {
    const fetcher = (async (url: string | URL | Request) => {
      if (String(url).includes("ok.example")) {
        return new Response("<html><body><p>hello &amp; world</p></body></html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      if (String(url).includes("empty-500.example")) {
        return new Response("", { status: 500 });
      }
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const fetchService = createLocalWebFetchService(fetcher);
    const ok = await fetchService(undefined, "https://ok.example/page");
    assert.equal(ok.content, "hello & world");
    const failed = await fetchService(undefined, "https://empty-500.example/x");
    assert.ok(failed.error?.includes("500"));
    const crashed = await fetchService(undefined, "https://crash.example/x");
    assert.ok(crashed.error?.includes("boom"));
  });
  test("rejects non-http schemes", async () => {
    const service = createLocalWebFetchService((async () => new Response("")) as unknown as typeof fetch);
    const result = await service(undefined, "file:///etc/passwd");
    assert.ok(result.error?.includes("Only http(s)"));
  });
});

describe("local web search service", () => {
  test("returns bing-parsed documents; empty serp throws", async () => {
    const fetcher = (async (url: string | URL | Request) => {
      if (String(url).includes("q=good")) return new Response(BING_FIXTURE, { status: 200 });
      return new Response("<html><ol></ol></html>", { status: 200 });
    }) as unknown as typeof fetch;
    const search = createLocalWebSearchService(fetcher);
    const good = await search(undefined, { searchTerm: "good query" });
    assert.equal(good.documents.length, 2);
    assert.ok(good.answer.includes("NVDA"));
    await assert.rejects(() => search(undefined, { searchTerm: "bad query" }), /no results/);
  });
});
