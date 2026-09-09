// Shared name matching for the durable narrative journal.
export const NARRATIVE_TTL_MS = 86_400_000;
export const NARRATIVE_NEW_MS = 600_000;
const token = (row) => String(row.meme || row.token || '');
const chain = (row) => Number(row.chain_id ?? 4663);
const amount = (value) =>
  Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

export const nameKey = (value) =>
  value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 64);

function distance(a, b) {
  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    const next = [j];
    for (let i = 1; i <= a.length; i++)
      next[i] = Math.min(
        next[i - 1] + 1,
        prev[i] + 1,
        prev[i - 1] + Number(a[i - 1] !== b[j - 1]),
      );
    prev = next;
  }
  return prev[a.length];
}

export function similar(a, b) {
  if (a === b) return true;
  const lo = Math.min(a.length, b.length),
    hi = Math.max(a.length, b.length);
  return (
    lo >= 5 &&
    hi / lo <= 1.35 &&
    distance(a, b) <= Math.max(1, Math.floor(hi * 0.2))
  );
}

export function groupNarrativeTokens(rows) {
  const unique = new Map();
  for (const row of rows) {
    const address = token(row).toLowerCase();
    const name = String(row.name || row.sym || '')
        .trim()
        .slice(0, 80),
      key = nameKey(name);
    if (!address || key.length < 2) continue;
    const id = `${chain(row)}:${address}`,
      flow = amount(row.total_in) ?? 0;
    const item = unique.get(id);
    if (!item || flow > item.flow) unique.set(id, { id, name, key, flow });
  }
  const items = [...unique.values()],
    parent = items.map((_, i) => i);
  const root = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      if (similar(items[i].key, items[j].key)) parent[root(j)] = root(i);
    }
  const groups = new Map();
  items.forEach((item, i) => {
    const key = root(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const variants = new Map();
      for (const item of group) {
        const variant = variants.get(item.key) || {
          name: item.name,
          count: 0,
          flow: 0,
          best: -1,
        };
        variant.count++;
        variant.flow += item.flow;
        if (item.flow > variant.best) {
          variant.name = item.name;
          variant.best = item.flow;
        }
        variants.set(item.key, variant);
      }
      const best = [...variants.values()].sort(
        (a, b) => b.count - a.count || b.flow - a.flow,
      )[0];
      return {
        members: group,
        name: best.name,
        count: group.length,
        flow: group.reduce((sum, item) => sum + item.flow, 0),
      };
    })
    .sort(
      (a, b) =>
        b.count - a.count || b.flow - a.flow || a.name.localeCompare(b.name),
    );
}
