import { z } from 'zod';
import { badRequest } from './errors.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    const path = first?.path.join('.');
    throw badRequest(path ? `${path}: ${first.message}` : (first?.message ?? 'Invalid request'), r.error.issues);
  }
  return r.data;
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });
