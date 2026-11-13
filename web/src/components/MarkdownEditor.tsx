import { useEffect, useRef } from 'react';
import { EditorState, EditorSelection, type ChangeSpec } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';

type Props = {
  initialValue: string;
  onChange: (value: string) => void;
  /** Scroll position as a 0..1 fraction, for preview scroll sync. */
  onScrollRatio?: (ratio: number) => void;
};

function wrap(view: EditorView, before: string, after = before, fallback = 'text'): boolean {
  const tr = view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to) || fallback;
    const insert = before + text + after;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(range.from + before.length, range.from + before.length + text.length),
    };
  });
  view.dispatch(tr, { scrollIntoView: true, userEvent: 'input' });
  view.focus();
  return true;
}

function prefixLines(view: EditorView, prefix: string | ((i: number) => string)): boolean {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let n = first, i = 0; n <= last; n++, i++) {
      const line = state.doc.line(n);
      const p = typeof prefix === 'string' ? prefix : prefix(i);
      // Replace an existing heading marker instead of stacking them.
      const existing = /^#{1,6}\s/.exec(line.text);
      changes.push({ from: line.from, to: line.from + (existing && p.startsWith('#') ? existing[0].length : 0), insert: p });
    }
  }
  view.dispatch({ changes, userEvent: 'input' });
  view.focus();
  return true;
}

function insertBlock(view: EditorView, text: string): boolean {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const lead = line.text.trim() ? '\n\n' : '';
  view.dispatch({ changes: { from: line.to, insert: lead + text }, selection: { anchor: line.to + lead.length + text.length }, userEvent: 'input' });
  view.focus();
  return true;
}

const TABLE = '| Column | Column |\n| --- | --- |\n| Cell | Cell |\n';

const actions: { label: string; title: string; run: (v: EditorView) => boolean }[] = [
  { label: 'H2', title: 'Heading 2', run: (v) => prefixLines(v, '## ') },
  { label: 'H3', title: 'Heading 3', run: (v) => prefixLines(v, '### ') },
  { label: 'B', title: 'Bold (Ctrl+B)', run: (v) => wrap(v, '**') },
  { label: 'I', title: 'Italic (Ctrl+I)', run: (v) => wrap(v, '_') },
  { label: '</>', title: 'Inline code (Ctrl+E)', run: (v) => wrap(v, '`', '`', 'code') },
  { label: '```', title: 'Code block', run: (v) => wrap(v, '```bash\n', '\n```', 'command') },
  { label: 'Link', title: 'Link', run: (v) => wrap(v, '[', '](https://)', 'link text') },
  { label: '• List', title: 'Bulleted list', run: (v) => prefixLines(v, '- ') },
  { label: '1. List', title: 'Numbered list', run: (v) => prefixLines(v, (i) => `${i + 1}. `) },
  { label: '☐ Task', title: 'Checklist', run: (v) => prefixLines(v, '- [ ] ') },
  { label: 'Table', title: 'Table', run: (v) => insertBlock(v, TABLE) },
];

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px', backgroundColor: 'var(--bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-subtle)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
});

export function MarkdownEditor({ initialValue, onChange, onScrollRatio }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onScrollRef = useRef(onScrollRatio);
  onChangeRef.current = onChange;
  onScrollRef.current = onScrollRatio;

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          history(),
          bracketMatching(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          placeholder('Write in Markdown…'),
          keymap.of([
            { key: 'Mod-b', run: (v) => wrap(v, '**') },
            { key: 'Mod-i', run: (v) => wrap(v, '_') },
            { key: 'Mod-e', run: (v) => wrap(v, '`', '`', 'code') },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            scroll: (_e, v) => {
              const s = v.scrollDOM;
              const max = s.scrollHeight - s.clientHeight;
              onScrollRef.current?.(max > 0 ? s.scrollTop / max : 0);
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    view.focus();
    return () => view.destroy();
    // The editor owns its document after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="md-editor">
      <div className="toolbar" role="toolbar" aria-label="Formatting">
        {actions.map((a) => (
          <button key={a.label} type="button" title={a.title} onMouseDown={(e) => e.preventDefault()} onClick={() => viewRef.current && a.run(viewRef.current)}>
            {a.label}
          </button>
        ))}
      </div>
      <div className="cm-host" ref={host} />
    </div>
  );
}
