// series.ts – folds a run of parameters that differ only by a counting number ("Step 00 Osc2", "Step 01 Osc2", …,
// a table a device keeps one parameter per step) into one entry with its values as a list, so a device with hundreds
// of such parameters stays readable. Each one keeps its address: the n-th value is the parameter at the first
// address plus n.

/** Fewer parameters than this in a row are listed one by one. */
export const SERIES_MIN = 8;

type Row = Record<string, unknown>;

/** The name split around its digit runs: text, digits, text, digits, …, text. */
const split = (name: string) => name.split(/(\d+)/);

/** The name with its j-th digit run blanked, plus the range, which a series shares. */
function keyOf(row: Row, j: number): string | undefined {
  const parts = split(String(row.name));
  if (2 * j + 1 >= parts.length) return undefined;
  parts[2 * j + 1] = "\u0000";
  return `${parts.join("")}\u0001${row.min}\u0001${row.max}`;
}

const numberAt = (row: Row, j: number) => Number(split(String(row.name))[2 * j + 1]);

/** "Step 00 Osc2" and "Step 64 Osc2" -> "Step 00..64 Osc2": the run that differs written as a range. */
function rangeName(first: string, last: string): string {
  const a = split(first);
  const b = split(last);
  if (a.length !== b.length) return `${first}..${last}`;
  return a.map((p, i) => (p === b[i] ? p : `${p}..${b[i]}`)).join("");
}

export function foldSeries(rows: Row[]): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < rows.length; ) {
    // The longest run from here in which one number counts up by one and everything else stays the same.
    let best = 1;
    const runs = Math.floor(split(String(rows[i].name)).length / 2);
    for (let j = 0; j < runs; j++) {
      const key = keyOf(rows[i], j);
      let n = 1;
      while (i + n < rows.length && keyOf(rows[i + n], j) === key && numberAt(rows[i + n], j) === numberAt(rows[i], j) + n) n++;
      best = Math.max(best, n);
    }
    if (best < SERIES_MIN) {
      out.push(rows[i++]);
      continue;
    }
    const run = rows.slice(i, i + best);
    const [first, last] = [run[0], run[run.length - 1]];
    const series: Row = {
      series: rangeName(String(first.name), String(last.name)),
      addresses: `${first.address}..${String(last.address).split("/").pop()}`,
    };
    if (first.longName !== undefined) series.longName = rangeName(String(first.longName), String(last.longName));
    series.count = run.length;
    series.min = first.min;
    series.max = first.max;
    if (run.every((r) => r.value !== undefined)) series.values = run.map((r) => r.value);
    if (run.some((r) => r.display !== undefined)) series.display = run.map((r) => r.display);
    if (first.unit !== undefined) series.unit = first.unit;
    if (first.help !== undefined) series.help = first.help;
    if (run.some((r) => r.askFirst)) series.askFirst = true;
    out.push(series);
    i += best;
  }
  return out;
}
