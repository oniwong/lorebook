import type { ReactNode } from 'react';

/** Renders text with <mark> around the given [start, end) ranges. Ranges come from the server, text stays text. */
export function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (!ranges.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a < at || b > text.length) continue;
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={a}>{text.slice(a, b)}</mark>);
    at = b;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
