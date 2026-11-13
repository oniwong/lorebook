import { useMemo } from 'react';
import { diffLines, diffWordsWithSpace } from 'diff';

type Line = { type: 'same' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number };

function toLines(a: string, b: string): Line[] {
  const out: Line[] = [];
  let o = 1;
  let n = 1;
  for (const part of diffLines(a, b)) {
    const lines = part.value.replace(/\n$/, '').split('\n');
    for (const text of lines) {
      if (part.added) out.push({ type: 'add', text, newNo: n++ });
      else if (part.removed) out.push({ type: 'del', text, oldNo: o++ });
      else out.push({ type: 'same', text, oldNo: o++, newNo: n++ });
    }
  }
  return out;
}

/** Collapses long unchanged stretches to a few lines of context around each change. */
function withContext(lines: Line[], ctx = 3): (Line | { type: 'gap'; count: number })[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.type !== 'same') for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) keep[j] = true;
  });
  const out: (Line | { type: 'gap'; count: number })[] = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap) out.push({ type: 'gap', count: gap });
      gap = 0;
      out.push(l);
    } else gap++;
  });
  if (gap) out.push({ type: 'gap', count: gap });
  return out;
}

type Row = { left?: Line; right?: Line } | { gap: number };

function sideBySide(lines: (Line | { type: 'gap'; count: number })[]): Row[] {
  const rows: Row[] = [];
  let dels: Line[] = [];
  let adds: Line[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ left: dels[i], right: adds[i] });
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.type === 'gap') { flush(); rows.push({ gap: l.count }); }
    else if (l.type === 'del') dels.push(l);
    else if (l.type === 'add') adds.push(l);
    else { flush(); rows.push({ left: l, right: l }); }
  }
  flush();
  return rows;
}

function WordDiff({ a, b, side }: { a: string; b: string; side: 'old' | 'new' }) {
  const parts = diffWordsWithSpace(a, b);
  return (
    <>
      {parts.map((p, i) => {
        if (p.added) return side === 'new' ? <mark key={i} className="w-add">{p.value}</mark> : null;
        if (p.removed) return side === 'old' ? <mark key={i} className="w-del">{p.value}</mark> : null;
        return <span key={i}>{p.value}</span>;
      })}
    </>
  );
}

export function DiffView({ oldText, newText, mode }: { oldText: string; newText: string; mode: 'inline' | 'split' }) {
  const lines = useMemo(() => withContext(toLines(oldText, newText)), [oldText, newText]);
  const rows = useMemo(() => (mode === 'split' ? sideBySide(lines) : []), [lines, mode]);

  if (oldText === newText) return <p className="muted">No differences in the text.</p>;

  if (mode === 'inline') {
    return (
      <table className="diff diff-inline">
        <colgroup><col className="ln-col" /><col className="ln-col" /><col /></colgroup>
        <tbody>
          {lines.map((l, i) =>
            l.type === 'gap' ? (
              <tr key={i} className="gap"><td colSpan={3}>⋯ {l.count} unchanged lines</td></tr>
            ) : (
              <tr key={i} className={l.type}>
                <td className="ln">{l.oldNo ?? ''}</td>
                <td className="ln">{l.newNo ?? ''}</td>
                <td className="code"><span className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>{l.text}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    );
  }

  return (
    <table className="diff diff-split">
      <colgroup><col className="ln-col" /><col /><col className="ln-col" /><col /></colgroup>
      <tbody>
        {rows.map((r, i) => {
          if ('gap' in r) return <tr key={i} className="gap"><td colSpan={4}>⋯ {r.gap} unchanged lines</td></tr>;
          const { left, right } = r;
          const changedPair = left?.type === 'del' && right?.type === 'add';
          return (
            <tr key={i}>
              <td className="ln">{left?.oldNo ?? ''}</td>
              <td className={`code ${left ? (left.type === 'same' ? 'same' : 'del') : 'empty'}`}>
                {left && (changedPair ? <WordDiff a={left.text} b={right!.text} side="old" /> : left.text)}
              </td>
              <td className="ln">{right?.newNo ?? ''}</td>
              <td className={`code ${right ? (right.type === 'same' ? 'same' : 'add') : 'empty'}`}>
                {right && (changedPair ? <WordDiff a={left!.text} b={right.text} side="new" /> : right.text)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
