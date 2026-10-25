// Pure line diff (Myers) rendered as unified-diff hunks. Explain Commit uses
// it where the engine cannot produce the commit's patch itself (Restricted
// Mode, no git CLI, the web), from the two versions of each changed file.

type Op = { kind: ' ' | '-' | '+'; line: string };

/** Above this many edits the middle is reported as one replacement rather
 *  than searched further; the result is still a correct diff. */
const MAX_EDIT_DISTANCE = 1000;

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The shortest edit script between two line arrays. */
export function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Op[] = a.slice(0, start).map((line) => ({ kind: ' ', line }));
  ops.push(...middle(a.slice(start, endA), b.slice(start, endB)));
  ops.push(...a.slice(endA).map((line): Op => ({ kind: ' ', line })));
  return ops;
}

function middle(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const replace = (): Op[] => [
    ...a.map((line): Op => ({ kind: '-', line })),
    ...b.map((line): Op => ({ kind: '+', line })),
  ];
  if (n === 0 || m === 0) return replace();
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
  }
  if (found < 0) return replace();

  // Walk the trace back from (n, m) to recover the edits.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: ' ', line: a[x - 1] });
      x--;
      y--;
    }
    if (down) ops.push({ kind: '+', line: b[y - 1] });
    else ops.push({ kind: '-', line: a[x - 1] });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: ' ', line: a[x - 1] });
    x--;
    y--;
  }
  return ops.reverse();
}

/** Unified-diff hunks (with `@@` headers) for the change from `before` to
 *  `after`, with `context` unchanged lines around each change. Empty when
 *  the texts are equal. */
export function unifiedDiff(before: string, after: string, context = 3): string {
  const ops = diffLines(splitLines(before), splitLines(after));
  const changed = ops.map((op) => op.kind !== ' ');
  const out: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (!changed[i]) {
      i++;
      continue;
    }
    // A hunk spans changes separated by at most 2 * context unchanged lines.
    const startIndex = Math.max(0, i - context);
    let end = i;
    let lastChange = i;
    while (end < ops.length) {
      if (changed[end]) lastChange = end;
      else if (end - lastChange > 2 * context) break;
      end++;
    }
    const stop = Math.min(ops.length, lastChange + context + 1);
    let oldStart = 1;
    let newStart = 1;
    for (let j = 0; j < startIndex; j++) {
      if (ops[j].kind !== '+') oldStart++;
      if (ops[j].kind !== '-') newStart++;
    }
    const body = ops.slice(startIndex, stop);
    const oldLines = body.filter((op) => op.kind !== '+').length;
    const newLines = body.filter((op) => op.kind !== '-').length;
    out.push(
      `@@ -${oldLines === 0 ? oldStart - 1 : oldStart},${oldLines} +${newLines === 0 ? newStart - 1 : newStart},${newLines} @@`,
    );
    for (const op of body) out.push(`${op.kind}${op.line}`);
    i = stop;
  }
  return out.join('\n');
}
