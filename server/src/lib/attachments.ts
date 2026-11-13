// Attachment storage (spec §7). Files are content-addressed: stored once under their SHA-256 in
// /data/attachments/ab/cd/<sha256>, never changed in place, and removed only by the nightly GC once no
// attachment row references them. Rows live as long as their page (including while it is in the trash).
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, unlink, utimes } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db } from '../db/index.js';
import { attachments } from '../db/schema.js';
import { config } from '../config.js';
import { HttpError } from './errors.js';

export const attachmentsDir = () => join(config.dataDir, 'attachments');
const tmpDir = () => join(attachmentsDir(), 'tmp');

export function blobPath(sha256: string): string {
  return join(attachmentsDir(), sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.7z': 'application/x-7z-compressed',
  '.vsdx': 'application/vnd.ms-visio.drawing', '.vsd': 'application/vnd.visio',
  '.drawio': 'application/vnd.jgraph.mxfile',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.json': 'application/json', '.xml': 'application/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.csv': 'text/csv', '.md': 'text/markdown', '.html': 'text/html', '.htm': 'text/html',
};

/** Extensions shown as an inline, syntax-highlighted text preview. */
const TEXT_EXT = new Set([
  '.txt', '.log', '.md', '.conf', '.cfg', '.cnf', '.ini', '.env', '.properties', '.toml', '.yaml', '.yml', '.json',
  '.xml', '.csv', '.tsv', '.ps1', '.psm1', '.psd1', '.bat', '.cmd', '.sh', '.bash', '.zsh', '.py', '.rb', '.pl',
  '.js', '.ts', '.sql', '.tf', '.hcl', '.nginx', '.service', '.timer', '.rules', '.reg', '.vbs', '.cs', '.go',
  '.html', '.htm', '.css', '.diff', '.patch', '.pem', '.crt', '.csr', '.pub', '.drawio',
]);

/** Image types the browser may display inline. SVG is included but served with a sandboxing CSP. */
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon', 'image/svg+xml', 'image/avif']);

/** Files with no extension that are still text (Dockerfile, hosts, ...). */
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'hosts', 'readme', 'license', 'krb5.conf', 'resolv.conf']);

export function contentTypeFor(filename: string): string {
  const ext = extname(filename).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  if (isTextFile(filename)) return 'text/plain';
  return 'application/octet-stream';
}

export function isTextFile(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return TEXT_EXT.has(ext) || (!ext && TEXT_NAMES.has(filename.toLowerCase()));
}

export function isInlineImage(contentType: string): boolean {
  return INLINE_IMAGES.has(contentType);
}

/** Keeps the last path segment and drops control characters and characters Windows rejects. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 200);
  return cleaned || 'file';
}

export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Streams an upload to a temp file while hashing it, then moves it into place. Nothing is buffered in
 * memory. Throws 413 (and deletes the partial file) as soon as `maxBytes` is exceeded.
 */
export async function storeUpload(input: Readable, maxBytes: number | null): Promise<{ sha256: string; size: number }> {
  await mkdir(tmpDir(), { recursive: true });
  const tmp = join(tmpDir(), `${Date.now()}-${randomBytes(8).toString('hex')}`);
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (maxBytes !== null && size > maxBytes) {
        cb(new HttpError(413, `The file is larger than the upload limit of ${Math.round(maxBytes / 1024 / 1024)} MB`));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(input, meter, createWriteStream(tmp, { flags: 'wx' }));
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  const sha256 = hash.digest('hex');
  const dest = blobPath(sha256);
  try {
    await stat(dest);
    // Already stored: keep the existing copy, and touch it so a concurrent GC run leaves it alone.
    await unlink(tmp);
    const now = new Date();
    await utimes(dest, now, now);
  } catch {
    await mkdir(join(dest, '..'), { recursive: true });
    await rename(tmp, dest);
  }
  return { sha256, size };
}

const GC_GRACE_MS = 60 * 60_000;

/** Deletes stored files no attachment row references, plus abandoned temp files. */
export async function gcAttachments(): Promise<{ removed: number; bytes: number }> {
  const root = attachmentsDir();
  const referenced = new Set((await db.selectDistinct({ sha: attachments.sha256 }).from(attachments)).map((r) => r.sha));
  let removed = 0;
  let bytes = 0;
  const now = Date.now();
  const list = async (dir: string) => {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const a of await list(root)) {
    if (!a.isDirectory()) continue;
    const isTmp = a.name === 'tmp';
    if (!isTmp && !/^[0-9a-f]{2}$/.test(a.name)) continue;
    const level1 = join(root, a.name);
    const files: string[] = [];
    if (isTmp) {
      for (const f of await list(level1)) if (f.isFile()) files.push(join(level1, f.name));
    } else {
      for (const b of await list(level1)) {
        if (!b.isDirectory()) continue;
        for (const f of await list(join(level1, b.name))) if (f.isFile()) files.push(join(level1, b.name, f.name));
      }
    }
    for (const file of files) {
      const name = file.split('/').pop()!;
      if (!isTmp && referenced.has(name)) continue;
      const s = await stat(file).catch(() => null);
      // Grace period: an upload may be between writing the file and inserting its row.
      if (!s || now - s.mtimeMs < (isTmp ? 24 * GC_GRACE_MS : GC_GRACE_MS)) continue;
      await unlink(file).catch(() => undefined);
      removed++;
      bytes += s.size;
    }
  }
  return { removed, bytes };
}
