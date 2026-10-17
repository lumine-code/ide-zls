const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createGithubFetch } = require("../spec/helpers/github-fetch");
const API = "https://api.github.com/repos/zigtools/zls/releases/tags/0.16.0";
const TOKEN = "fixture-github-token";

test("authenticates only the exact HTTPS API origin and preserves headers and cancellation", async () => {
  const controller = new AbortController();
  const original = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "Lumine.ide",
    "X-Fixture": "kept",
  });
  let captured;
  const response = new Response('{"tag_name":"0.16.0"}');
  const transport = createGithubFetch({
    token: TOKEN,
    fetchUrl: async (url, init) => {
      captured = { url, init };
      return response;
    },
  });
  assert.equal(
    await transport(API, { headers: original, signal: controller.signal, cache: "no-store" }),
    response,
  );
  assert.equal(captured.url, API);
  assert.equal(captured.init.headers.get("Authorization"), `Bearer ${TOKEN}`);
  for (const [key, value] of original) assert.equal(captured.init.headers.get(key), value);
  assert.equal(captured.init.signal, controller.signal);
  assert.equal(captured.init.cache, "no-store");
  assert.equal(captured.init.redirect, "manual");
  assert.equal(original.has("Authorization"), false, "caller headers stay unchanged");
});

test("never forwards credentials to archives, alternate schemes, ports or lookalike origins", async () => {
  const requests = [];
  const transport = createGithubFetch({
    token: TOKEN,
    fetchUrl: async (url, init) => {
      requests.push({ url, init });
      return new Response("archive");
    },
  });
  const urls = [
    "https://github.com/zigtools/zls/releases/download/0.16.0/zls-x86_64-linux.tar.xz",
    "https://release-assets.githubusercontent.com/asset",
    "https://api.github.com.example.invalid/repos/zigtools/zls/releases/latest",
    "http://api.github.com/repos/zigtools/zls/releases/latest",
    "https://api.github.com:444/repos/zigtools/zls/releases/latest",
    "https://someone@api.github.com/repos/zigtools/zls/releases/latest",
  ];
  for (const url of urls)
    await transport(url, { headers: { Authorization: `Bearer ${TOKEN}`, "X-Fixture": "kept" } });
  for (const { init } of requests) {
    assert.equal(init.headers.has("Authorization"), false);
    assert.equal(init.headers.get("X-Fixture"), "kept");
    assert.equal(init.redirect, "follow");
  }
});

test("refuses metadata redirects without fetching their location or leaking the token", async () => {
  const requests = [],
    diagnostics = [];
  const transport = createGithubFetch({
    token: TOKEN,
    onFailure: (details) => diagnostics.push(details),
    fetchUrl: async (url, init) => {
      requests.push({ url, init });
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://release-assets.githubusercontent.com/private",
          "X-GitHub-Request-Id": "request-1",
        },
      });
    },
  });
  await assert.rejects(transport(API), /metadata redirect was refused/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, API);
  assert.equal(requests[0].init.redirect, "manual");
  assert.deepEqual(diagnostics, [
    {
      status: 302,
      path: "/repos/zigtools/zls/releases/tags/0.16.0",
      headers: { "x-github-request-id": "request-1" },
    },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes(TOKEN), false);
});

test("a real HTTP redirect never reaches the other origin with the fixture credential", async (context) => {
  const listen = (server) =>
    new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const close = (server) =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  let assetRequests = 0,
    metadataAuthorization;
  const asset = http.createServer((_request, response) => {
    assetRequests++;
    response.end("archive");
  });
  const assetPort = await listen(asset);
  context.after(() => close(asset));
  const metadata = http.createServer((request, response) => {
    metadataAuthorization = request.headers.authorization;
    response.writeHead(302, { Location: `http://127.0.0.1:${assetPort}/archive` });
    response.end();
  });
  const metadataPort = await listen(metadata);
  context.after(() => close(metadata));
  const transport = createGithubFetch({
    token: TOKEN,
    onFailure() {},
    // Route the nominal API origin to an owned loopback fixture while retaining
    // the real fetch implementation's redirect and credential behavior.
    fetchUrl: (_url, init) => fetch(`http://127.0.0.1:${metadataPort}/metadata`, init),
  });
  await assert.rejects(transport(API), /metadata redirect was refused/);
  assert.equal(metadataAuthorization, `Bearer ${TOKEN}`);
  assert.equal(assetRequests, 0);
});

test("records bounded safe GitHub failure details without retrying or exposing credentials", async () => {
  let calls = 0;
  const diagnostics = [];
  const transport = createGithubFetch({
    token: TOKEN,
    onFailure: (details) => diagnostics.push(details),
    fetchUrl: async () => {
      calls++;
      return Response.json(
        { message: `rate limit ${TOKEN} ` + "x".repeat(500) },
        {
          status: 403,
          headers: {
            "X-RateLimit-Remaining": "0",
            "Retry-After": "60",
            Authorization: `Bearer ${TOKEN}`,
          },
        },
      );
    },
  });
  const response = await transport(API, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(response.status, 403);
  assert.equal(calls, 1);
  assert.equal(diagnostics[0].message.length, 256);
  assert.ok(diagnostics[0].message.includes("[redacted]"));
  assert.deepEqual(diagnostics[0].headers, { "x-ratelimit-remaining": "0", "retry-after": "60" });
  assert.equal(JSON.stringify(diagnostics).includes(TOKEN), false);
  assert.equal(JSON.stringify(diagnostics).toLowerCase().includes("authorization"), false);
});

test("supports anonymous local runs and propagates transport failures unchanged", async () => {
  const expected = new Error("transport failed");
  const transport = createGithubFetch({
    fetchUrl: async (_url, init) => {
      assert.equal(init.headers.has("Authorization"), false);
      throw expected;
    },
  });
  await assert.rejects(transport(API), (error) => error === expected);
});
