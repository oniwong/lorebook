import type { StoredFinding } from '../lib/api';

/** A list of masked secret-scan findings: line, rule and a preview with the value hidden. */
export function SecretFindings({ findings, max = 20 }: { findings: StoredFinding[]; max?: number }) {
  return (
    <ul className="finding-list">
      {findings.slice(0, max).map((f, i) => (
        <li key={`${f.line}-${i}`}>
          <span className="muted small">Line {f.line} · {f.ruleName}</span>
          <code>{f.preview}</code>
        </li>
      ))}
      {findings.length > max && <li className="muted small">…and {findings.length - max} more</li>}
    </ul>
  );
}
