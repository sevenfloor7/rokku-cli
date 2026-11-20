// In-memory DATA with the shape the agent guide's topic=data describes (get/page/receipt/putResult/deleteResult).
export function memoryData({pageSize = 2} = {}) {
  const PAGE = pageSize;
  const tables = new Map(), receipts = new Map();
  let generation = 1, dataRevision = 0;
  const table = name => tables.get(name) ?? tables.set(name, new Map()).get(name);
  const commit = (collection, mutation, deleted) => {
    const rows = table(collection), current = rows.get(mutation.recordId);
    if ((current?.revision ?? 0) !== mutation.expectedRevision) return {kind: "conflict"};
    if (mutation.expectedGeneration !== undefined && mutation.expectedGeneration !== generation) return {kind: "conflict"};
    if (!deleted && (mutation.value === null || typeof mutation.value !== "object" || Array.isArray(mutation.value)))
      throw Error("value must be an object");
    if (!deleted && typeof mutation.sortKey !== "string") throw Error("sortKey required");
    // Rokku DATA refuses records over about 16 KB (seen on test as a 503).
    if (!deleted && new TextEncoder().encode(JSON.stringify(mutation.value)).length > 16 * 1024)
      throw Error("record too large");
    const row = {record_id: mutation.recordId, sort_key: deleted ? current.sort_key : mutation.sortKey,
      value: deleted ? null : mutation.value, revision: (current?.revision ?? 0) + 1, deleted};
    rows.set(mutation.recordId, row);
    dataRevision++;
    const receipt = {mutation_id: mutation.mutationId, record_id: row.record_id, revision: row.revision};
    receipts.set(`${collection}:${mutation.mutationId}`, receipt);
    return {kind: "committed", receipt};
  };
  return {
    get: async (collection, id) => table(collection).get(id) ?? null,
    page: async (collection, limit, after) => {
      const rows = [...table(collection).values()].sort((a, b) =>
        a.sort_key.localeCompare(b.sort_key) || a.record_id.localeCompare(b.record_id));
      // Like Rokku DATA: a keyset cursor (sortKey, recordId) pinned to the generation and data revision
      // it was read at; any write in between refuses it with data_revision_changed.
      if (after && (after.generation !== generation || after.dataRevision !== dataRevision)) throw Error("data_revision_changed: the listing moved on");
      const past = row => !after || row.sort_key > after.sortKey || (row.sort_key === after.sortKey && row.record_id > after.recordId);
      const rest = rows.filter(past), slice = rest.slice(0, Math.min(limit, PAGE)), last = slice.at(-1);
      return {records: slice, next: rest.length > slice.length
        ? {sortKey: last.sort_key, recordId: last.record_id, generation, dataRevision} : null,
        generation, data_revision: dataRevision};
    },
    receipt: async (collection, id) => receipts.get(`${collection}:${id}`) ?? null,
    putResult: async (collection, mutation) => commit(collection, mutation, false),
    deleteResult: async (collection, mutation) => commit(collection, mutation, true),
  };
}

