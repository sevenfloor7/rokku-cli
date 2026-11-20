// The CLI goes through HTTP(S)_PROXY when one is set, and says plainly when Rokku can't be reached.
import assert from "node:assert/strict";
import http, {createServer, request as forward} from "node:http";
import {AGENT, fakeApi} from "./fake-api.mjs";

const api = await fakeApi({"GET /v1/user/info": () => ({email: "x@example.com", agents: [{agent_id: AGENT}]})});

// A plain HTTP forward proxy that records what it carried.
const carried = [];
const proxy = createServer((incoming, outgoing) => {
  carried.push(incoming.url);
  const target = new URL(incoming.url);
  incoming.pipe(forward({host: target.hostname, port: target.port, path: target.pathname + target.search, method: incoming.method, headers: incoming.headers},
    upstream => { outgoing.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(outgoing); }));
});
const port = await new Promise(done => proxy.listen(0, "127.0.0.1", () => done(proxy.address().port)));

// Node 22.21+ and 24+ can route fetch through HTTP(S)_PROXY; older Node can't, and the CLI says so when Rokku is unreachable.
if (http.setGlobalProxyFromEnv) {
  const viaProxy = await api.run(["whoami"], "", {HTTP_PROXY: `http://127.0.0.1:${port}`});
  assert.equal(viaProxy.code, 0, viaProxy.stderr);
  assert.ok(carried.some(url => url.endsWith("/v1/user/info")), "requests go through HTTP_PROXY");
}

// A port nothing listens on.
const closed = createServer();
const free = await new Promise(done => closed.listen(0, "127.0.0.1", () => done(closed.address().port)));
await new Promise(done => closed.close(done));
const unreachable = await api.run(["whoami"], "", {ROKKU_API: `http://127.0.0.1:${free}`});
assert.equal(unreachable.code, 5);
assert.match(unreachable.stderr, /Could not reach Rokku \(ECONNREFUSED\): check this laptop's network$/);
assert.doesNotMatch(unreachable.stderr, /even hour/);

proxy.close(); api.close();
console.log("ok — requests follow HTTP(S)_PROXY; an unreachable Rokku is reported as a network problem");
