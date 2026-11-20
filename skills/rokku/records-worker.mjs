// Platform module: copy it unchanged into a creation that stores data. Copied from rokku-backend
// backend/rokku/runtimes/deepagents/artifact_runtime_records_worker.mjs (test d87b952c3); refresh it
// when the platform block changes. The CLI's tests run against this copy.
/** Platform records block (version 1): DATA create/edit/delete, cursor pages and
 * receipts for declared collections. Pair with RokkuDataClient.bindRecords.
 * Routes: GET/POST/DELETE /api/records/<collection>, GET /api/records/<collection>/receipt?id=,
 * GET /api/records/<collection>/record?id= (one record, including a deleted one's revision).
 * App-specific routes go first through `routes`; return nothing to fall through. */
// Ask for the largest page; DATA clamps it to its Host-owned row window.
const REQUESTED_PAGE_ROWS = Number.MAX_SAFE_INTEGER;
const ROUTE = /^\/api\/records\/([^/]+)(\/receipt|\/record)?$/;

export function recordsWorker({collections, routes} = {}) {
  if (!Array.isArray(collections) || !collections.length ||
    collections.some(name => typeof name !== "string" || !name))
    throw Error("recordsWorker needs the declared DATA collection names");
  const known = new Set(collections);
  return {
    async fetch(request, env, ctx) {
      if (typeof routes === "function") {
        const own = await routes(request, env, ctx);
        if (own) return own;
      }
      const url = new URL(request.url), match = ROUTE.exec(url.pathname);
      if (match) {
        const collection = decodeURIComponent(match[1]), data = ctx.props.DATA;
        if (!known.has(collection)) return Response.json({kind:"unknown_collection"}, {status:404});
        if (match[2] === "/record") {
          const id = url.searchParams.get("id");
          if (request.method !== "GET") return new Response(null, {status:405});
          return id ? Response.json(await data.get(collection, id)) :
            Response.json({kind:"missing_id"}, {status:400});
        }
        if (match[2]) return request.method === "GET" ?
          Response.json(await data.receipt(collection, url.searchParams.get("id"))) :
          new Response(null, {status:405});
        if (request.method === "GET") {
          const after = url.searchParams.has("after") ? JSON.parse(url.searchParams.get("after")) : undefined;
          try { return Response.json(await data.page(collection, REQUESTED_PAGE_ROWS, after)); }
          catch (error) {
            if (typeof error?.message === "string" && error.message.includes("data_revision_changed:"))
              return Response.json({kind:"data_revision_changed"}, {status:409});
            throw error;
          }
        }
        if (["POST", "DELETE"].includes(request.method)) {
          // The shared browser client keeps the original bytes and generation for recovery.
          const input = await request.json();
          const result = request.method === "DELETE" ? await data.deleteResult(collection, input) :
            await data.putResult(collection, input);
          return result.kind === "committed" ? Response.json(result.receipt) :
            Response.json({kind:result.kind}, {status:result.kind === "reauthorize" ? 401 :
              result.kind === "budget_denied" ? 429 : 409});
        }
        return new Response(null, {status:405});
      }
      // Assets use html_handling=none; the launch origin must serve the page too.
      if (url.pathname === "/" && ["GET", "HEAD"].includes(request.method)) {
        url.pathname = "/index.html";
        return env.ASSETS.fetch(new Request(url, request));
      }
      return env.ASSETS.fetch(request);
    },
  };
}
