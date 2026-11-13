import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments, pages, users } from '../db/schema.js';
import { requireUser, type SessionUser } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { idParam, parse } from '../lib/validate.js';
import {
  blobPath, cleanFilename, contentDisposition, contentTypeFor, isInlineImage, isTextFile, storeUpload,
} from '../lib/attachments.js';
import { checkedOutConflict, checkoutIsLive } from '../lib/pages.js';
import { getAppSettings } from '../lib/settings.js';

const PREVIEW_MAX = 512 * 1024;
// Served files may be attacker-controlled (an SVG with script, an HTML file): never let them run.
const FILE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

/** Uploading and removing attachments is blocked while someone else has the page checked out. */
async function pageForChange(pageId: number, user: SessionUser) {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(pages).where(eq(pages.id, pageId));
    if (!p || p.deletedAt) throw notFound('Page not found');
    if (checkoutIsLive(p) && p.checkedOutBy !== user.id) throw await checkedOutConflict(tx, p);
    return p;
  });
}

async function loadAttachment(id: number, user: SessionUser) {
  const [row] = await db.select({ a: attachments, pageDeleted: pages.deletedAt })
    .from(attachments).innerJoin(pages, eq(pages.id, attachments.pageId)).where(eq(attachments.id, id));
  // Files of trashed pages stay reachable for admins only, like the pages themselves.
  if (!row || (row.pageDeleted && user.role !== 'admin')) throw notFound('Attachment not found');
  return row.a;
}

function dto(a: typeof attachments.$inferSelect, uploader?: string) {
  return {
    id: a.id, pageId: a.pageId, filename: a.filename, contentType: a.contentType, size: a.size,
    createdAt: a.createdAt, uploadedBy: { id: a.uploadedBy, displayName: uploader ?? '' },
    url: `/api/v1/attachments/${a.id}/${encodeURIComponent(a.filename)}`,
    isImage: isInlineImage(a.contentType), isText: isTextFile(a.filename),
  };
}

function sendFile(reply: FastifyReply, a: typeof attachments.$inferSelect, download: boolean) {
  const inline = !download && isInlineImage(a.contentType);
  reply.header('Content-Type', a.contentType);
  reply.header('Content-Length', String(a.size));
  reply.header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', a.filename));
  reply.header('Content-Security-Policy', FILE_CSP);
  // The bytes behind an attachment id never change.
  reply.header('Cache-Control', 'private, max-age=31536000, immutable');
  return reply.send(createReadStream(blobPath(a.sha256)));
}

export async function attachmentRoutes(app: FastifyInstance) {
  // Uploads arrive as the raw request body and are streamed straight to disk (no multipart buffering).
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.get('/pages/:id/attachments', async (req) => {
    requireUser(req);
    const { id } = parse(idParam, req.params);
    const rows = await db.select({ a: attachments, uploader: users.displayName })
      .from(attachments).innerJoin(users, eq(users.id, attachments.uploadedBy))
      .where(and(eq(attachments.pageId, id), isNull(attachments.removedAt)))
      .orderBy(asc(attachments.filename), asc(attachments.id));
    return rows.map((r) => dto(r.a, r.uploader));
  });

  app.post('/pages/:id/attachments', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { filename } = parse(z.object({ filename: z.string().min(1).max(500) }), req.query);
    if (!req.headers['content-type']?.startsWith('application/octet-stream')) {
      throw badRequest('Send the file as the request body with Content-Type: application/octet-stream');
    }
    await pageForChange(id, user);
    const { uploadMaxMb } = await getAppSettings();
    const maxBytes = uploadMaxMb ? uploadMaxMb * 1024 * 1024 : null;
    const declared = Number(req.headers['content-length']);
    if (maxBytes !== null && Number.isFinite(declared) && declared > maxBytes) {
      req.raw.resume();
      throw Object.assign(new Error(`The file is larger than the upload limit of ${uploadMaxMb} MB`), { statusCode: 413 });
    }
    const name = cleanFilename(filename);
    const stored = await storeUpload(req.body as Readable, maxBytes);
    // Re-check: the page may have been trashed or checked out while the file streamed in.
    await pageForChange(id, user);
    const [a] = await db.insert(attachments).values({
      pageId: id, filename: name, contentType: contentTypeFor(name), size: stored.size, sha256: stored.sha256, uploadedBy: user.id,
    }).returning();
    req.log.info({ event: 'attachment_uploaded', pageId: id, attachmentId: a.id, size: a.size }, 'attachment uploaded');
    return dto(a, user.displayName);
  });

  /** Removes the attachment from the page's list. The file stays so older revisions that link to it still work. */
  app.delete('/attachments/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const a = await loadAttachment(id, user);
    await pageForChange(a.pageId, user);
    await db.update(attachments).set({ removedAt: new Date(), removedBy: user.id }).where(eq(attachments.id, id));
    return { ok: true };
  });

  app.get('/attachment-previews/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const a = await loadAttachment(id, user);
    if (!isTextFile(a.filename)) throw badRequest('No text preview for this file type');
    const fh = await open(blobPath(a.sha256), 'r');
    try {
      const len = Math.min(a.size, PREVIEW_MAX);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      return { filename: a.filename, text: buf.toString('utf8'), truncated: a.size > PREVIEW_MAX, size: a.size };
    } finally {
      await fh.close();
    }
  });

  const download = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { download: dl } = parse(z.object({ download: z.string().optional() }), req.query);
    const a = await loadAttachment(id, user);
    return sendFile(reply, a, dl !== undefined);
  };
  app.get('/attachments/:id', download);
  // The filename in the URL is cosmetic (nicer links and "save as" names); only the id is used.
  app.get('/attachments/:id/:name', download);
}
