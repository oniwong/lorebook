import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pages, templates } from '../db/schema.js';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const keyParam = z.object({ key: z.string() });
const fields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500),
  body: z.string().max(200_000),
  requiredSections: z.array(z.string().trim().min(1).max(100)).max(30),
  reviewIntervalMonths: z.number().int().min(1).max(120).nullable(),
  position: z.number().int().min(0).max(10_000),
};

async function getTemplate(key: string) {
  const [t] = await db.select().from(templates).where(eq(templates.key, key));
  if (!t) throw notFound('Template not found');
  return t;
}

export async function templateRoutes(app: FastifyInstance) {
  app.get('/templates', async (req) => {
    requireUser(req);
    return db.select({
      key: templates.key, name: templates.name, description: templates.description, body: templates.body,
      requiredSections: templates.requiredSections, reviewIntervalMonths: templates.reviewIntervalMonths,
      builtin: templates.builtin, position: templates.position, updatedAt: templates.updatedAt,
      pageCount: sql<number>`(select count(*)::int from pages p where p.template = ${templates.key} and p.deleted_at is null)`,
    }).from(templates).orderBy(asc(templates.position), asc(templates.name));
  });

  app.get('/templates/:key', async (req) => {
    requireUser(req);
    return getTemplate(parse(keyParam, req.params).key);
  });

  app.post('/templates', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(z.object({
      key: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,31}$/, 'Use 2-32 lowercase letters, digits or dashes'),
      name: fields.name,
      description: fields.description.default(''),
      body: fields.body.default(''),
      requiredSections: fields.requiredSections.default([]),
      reviewIntervalMonths: fields.reviewIntervalMonths.default(null),
      position: fields.position.default(100),
    }), req.body);
    const [existing] = await db.select({ id: templates.id }).from(templates).where(eq(templates.key, body.key));
    if (existing) throw conflict('A template with that key already exists');
    const [t] = await db.insert(templates).values({ ...body, builtin: false, updatedBy: admin.id }).returning();
    return t;
  });

  app.patch('/templates/:key', async (req) => {
    const admin = requireAdmin(req);
    const t = await getTemplate(parse(keyParam, req.params).key);
    const body = parse(z.object({
      name: fields.name.optional(),
      description: fields.description.optional(),
      body: fields.body.optional(),
      requiredSections: fields.requiredSections.optional(),
      reviewIntervalMonths: fields.reviewIntervalMonths.optional(),
      position: fields.position.optional(),
    }), req.body);
    // "blank" is the escape hatch when a template doesn't fit, so it can never require anything.
    if (t.key === 'blank' && body.requiredSections?.length) throw badRequest('The Blank template cannot have required sections');
    const [updated] = await db.update(templates).set({ ...body, updatedAt: new Date(), updatedBy: admin.id })
      .where(eq(templates.id, t.id)).returning();
    return updated;
  });

  app.delete('/templates/:key', async (req) => {
    requireAdmin(req);
    const t = await getTemplate(parse(keyParam, req.params).key);
    if (t.builtin) throw badRequest('Built-in templates can be edited but not deleted');
    const moved = await db.transaction(async (tx) => {
      const r = await tx.update(pages).set({ template: 'blank' }).where(eq(pages.template, t.key)).returning({ id: pages.id });
      await tx.delete(templates).where(eq(templates.id, t.id));
      return r.length;
    });
    return { ok: true, pagesSwitchedToBlank: moved };
  });
}
