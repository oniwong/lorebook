// CodeMirror extension that underlines possible secrets while typing (spec §8), using the same scanner and
// rules as the server's check-in check (lib/secrets.ts is shared).
import { StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { scanSecrets, type SecretFinding, type SecretScanConfig } from '../lib/secrets';

const setFindings = StateEffect.define<SecretFinding[]>();

function build(view: { state: EditorView['state'] }, findings: SecretFinding[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  for (const f of findings) {
    if (f.line > doc.lines) continue;
    const line = doc.line(f.line);
    const from = Math.min(line.from + f.column, line.to);
    const to = Math.min(from + f.length, line.to);
    if (to <= from) continue;
    b.add(from, to, Decoration.mark({
      class: 'cm-secret',
      attributes: { title: `Looks like a secret (${f.ruleName}). Store it in the password vault and link to the entry instead.` },
    }));
  }
  return b.finish();
}

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    for (const e of tr.effects) if (e.is(setFindings)) return build(tr, e.value);
    return tr.docChanged ? decos.map(tr.changes) : decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

class SecretMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-secret-marker';
    el.textContent = '⚠';
    el.title = 'Possible secret on this line';
    return el;
  }
}
const marker = new SecretMarker();

const secretGutter = gutter({
  class: 'cm-secret-gutter',
  lineMarker(view, line) {
    let found = false;
    view.state.field(field).between(line.from, line.to, () => { found = true; return false; });
    return found ? marker : null;
  },
  lineMarkerChange: (u) => u.transactions.some((t) => t.effects.some((e) => e.is(setFindings))) || u.docChanged,
});

/**
 * @param getConfig returns the current rules (or null while they load)
 * @param onFindings called after every scan, e.g. to show a count
 */
export function secretLint(getConfig: () => SecretScanConfig | null, onFindings?: (f: SecretFinding[]) => void) {
  const plugin = ViewPlugin.fromClass(class {
    timer: ReturnType<typeof setTimeout> | null = null;
    lastConfig: SecretScanConfig | null = null;
    constructor(readonly view: EditorView) {
      this.schedule(50);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || getConfig() !== this.lastConfig) this.schedule(400);
    }
    schedule(ms: number) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(), ms);
    }
    run() {
      this.timer = null;
      const config = getConfig();
      this.lastConfig = config;
      if (!config) {
        this.schedule(1000);
        return;
      }
      const findings = scanSecrets(this.view.state.doc.toString(), config);
      this.view.dispatch({ effects: setFindings.of(findings) });
      onFindings?.(findings);
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  });
  return [field, secretGutter, plugin];
}
