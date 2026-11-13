import { useEffect, useRef } from 'react';
import { EditorState, EditorSelection, type ChangeSpec } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { autocompletion, completionKeymap, startCompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type { PageRef } from '../lib/api';
import type { SecretFinding, SecretScanConfig } from '../lib/secrets';
import { secretLint } from './secretLint';

export type UploadResult = { url: string; filename: string; isImage: boolean };

type Props = {
  initialValue: string;
  onChange: (value: string) => void;
  /** Scroll position as a 0..1 fraction, for preview scroll sync. */
  onScrollRatio?: (ratio: number) => void;
  /** Uploads a pasted, dropped or picked file. Without it, files can't be added. */
  upload?: (file: File, onProgress: (p: number) => void) => Promise<UploadResult>;
  onUploadError?: (message: string) => void;
  /** Title search for the `[[` link picker. */
  searchPages?: (q: string) => Promise<PageRef[]>;
  /** Secret detection rules; possible secrets are underlined as you type. */
  secretConfig?: SecretScanConfig | null;
  onSecretFindings?: (findings: SecretFinding[]) => void;
};

let uploadSeq = 0;

function markdownFor(r: UploadResult): string {
  const label = r.filename.replace(/[[\]]/g, '');
  const url = r.url.replace(/\(/g, '%28').replace(/\)/g, '%29');
  return r.isImage ? `![${label}](${url})` : `[${label}](${url})`;
}

/**
 * Inserts a placeholder for each file at `pos`, uploads it, then swaps the placeholder for the final link.
 * Placeholders are found by text, so typing elsewhere during the upload is fine.
 */
function insertUploads(
  view: EditorView, files: File[], pos: number, upload: NonNullable<Props['upload']>, onError?: (m: string) => void,
) {
  const items = files.map((f) => ({ file: f, token: `[Uploading ${f.name.replace(/[[\]]/g, '') || 'image'} #${++uploadSeq}…]()` }));
  const text = items.map((i) => i.token).join('\n');
  view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length }, userEvent: 'input' });
  const replace = (token: string, insert: string) => {
    const at = view.state.doc.toString().indexOf(token);
    if (at >= 0) view.dispatch({ changes: { from: at, to: at + token.length, insert }, userEvent: 'input' });
  };
  for (const item of items) {
    upload(item.file, () => undefined).then(
      (r) => replace(item.token, markdownFor(r)),
      (e: Error) => {
        replace(item.token, '');
        onError?.(`${item.file.name}: ${e.message}`);
      },
    );
  }
}

function pageLinkCompletion(search: (q: string) => Promise<PageRef[]>) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const m = ctx.matchBefore(/\[\[[^\]\n]*/);
    if (!m) return null;
    const q = m.text.slice(2);
    const pages = await search(q);
    if (ctx.aborted) return null;
    return {
      from: m.from,
      filter: false,
      options: pages.map((p) => ({
        label: p.title,
        detail: p.spaceName,
        apply: (view: EditorView, _c: unknown, from: number, to: number) => {
          // Swallow a "]]" the user may already have typed after the query.
          const after = view.state.sliceDoc(to, to + 2) === ']]' ? 2 : 0;
          const insert = `[${p.title.replace(/[[\]]/g, '')}](/p/${p.id})`;
          view.dispatch({ changes: { from, to: to + after, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.complete' });
        },
      })),
    };
  };
}

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

export function MarkdownEditor({ initialValue, onChange, onScrollRatio, upload, onUploadError, searchPages, secretConfig, onSecretFindings }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  const onScrollRef = useRef(onScrollRatio);
  const uploadRef = useRef(upload);
  const onUploadErrorRef = useRef(onUploadError);
  const searchRef = useRef(searchPages);
  onChangeRef.current = onChange;
  onScrollRef.current = onScrollRatio;
  uploadRef.current = upload;
  onUploadErrorRef.current = onUploadError;
  searchRef.current = searchPages;
  const secretConfigRef = useRef(secretConfig ?? null);
  const onSecretRef = useRef(onSecretFindings);
  secretConfigRef.current = secretConfig ?? null;
  onSecretRef.current = onSecretFindings;

  const startUploads = (view: EditorView, files: File[], pos: number) => {
    const up = uploadRef.current;
    if (!up || !files.length) return false;
    insertUploads(view, files, pos, up, onUploadErrorRef.current);
    return true;
  };

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          lineNumbers(),
          secretLint(() => secretConfigRef.current, (f) => onSecretRef.current?.(f)),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          history(),
          bracketMatching(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          placeholder('Write in Markdown…  Type [[ to link to another page. Paste or drop files to attach them.'),
          autocompletion({
            override: [pageLinkCompletion((q) => searchRef.current?.(q) ?? Promise.resolve([]))],
            activateOnTyping: true,
            icons: false,
          }),
          keymap.of([
            ...completionKeymap,
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
            paste: (e, v) => {
              const files = [...(e.clipboardData?.files ?? [])];
              if (!files.length) return false;
              e.preventDefault();
              return startUploads(v, files, v.state.selection.main.head);
            },
            drop: (e, v) => {
              const files = [...(e.dataTransfer?.files ?? [])];
              if (!files.length) return false;
              e.preventDefault();
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
              return startUploads(v, files, pos);
            },
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
        <button type="button" title="Link to another page (or type [[)" onMouseDown={(e) => e.preventDefault()}
          onClick={() => { const v = viewRef.current; if (v) { v.dispatch(v.state.replaceSelection('[['), { userEvent: 'input.type' }); v.focus(); startCompletion(v); } }}>
          [[Page]]
        </button>
        {upload && (
          <>
            <button type="button" title="Attach files (or paste / drop them into the editor)" onMouseDown={(e) => e.preventDefault()} onClick={() => fileInput.current?.click()}>
              📎 Attach
            </button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => {
              const v = viewRef.current;
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (v) { startUploads(v, files, v.state.selection.main.head); v.focus(); }
            }} />
          </>
        )}
      </div>
      <div className="cm-host" ref={host} />
    </div>
  );
}
