import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";

import { rejectUntrustedBrowserRequest } from "../../src/host/gateway-server.ts";

function mockRes() {
  const out: { status?: number; body?: string | undefined } = {};
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    end(body?: string) { out.body = body; },
  } as unknown as ServerResponse;
  return { res, out };
}

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("rejectUntrustedBrowserRequest", () => {
  test("allows loopback pages to call the same-origin API", () => {
    const { res, out } = mockRes();
    const blocked = rejectUntrustedBrowserRequest(
      {},
      req({ origin: "http://127.0.0.1:7331", host: "127.0.0.1:7331" }),
      res,
    );
    assert.equal(blocked, false);
    assert.equal(out.status, undefined);
  });

  test("still blocks a non-loopback browser origin", () => {
    const { res, out } = mockRes();
    const blocked = rejectUntrustedBrowserRequest(
      {},
      req({ origin: "https://evil.example", host: "127.0.0.1:7331" }),
      res,
    );
    assert.equal(blocked, true);
    assert.equal(out.status, 403);
  });
});
