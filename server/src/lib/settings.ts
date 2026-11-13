import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { settings } from '../db/schema.js';

/** Settings admins can change in the UI, with their defaults. */
export type AppSettings = {
  /** Upload cap in MB; null means no limit (spec §7). */
  uploadMaxMb: number | null;
  /** Postgres text-search configuration used for full-text search (spec §9), e.g. simple, english, swedish. */
  searchLanguage: string;
  /** Months until the next review when a page is marked reviewed and its template sets no interval (spec §11). */
  defaultReviewMonths: number;
};

export const DEFAULT_SETTINGS: AppSettings = { uploadMaxMb: null, searchLanguage: 'simple', defaultReviewMonths: 12 };

export async function getSetting<T>(key: string, def: T): Promise<T> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return row ? (row.value as T) : def;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  // A JS null would become SQL NULL; store JSON null instead.
  const v = sql`${JSON.stringify(value ?? null)}::jsonb`;
  await db.insert(settings).values({ key, value: v })
    .onConflictDoUpdate({ target: settings.key, set: { value: v, updatedAt: sql`now()` } });
}

export async function getAppSettings(): Promise<AppSettings> {
  const rows = await db.select().from(settings);
  const out: AppSettings = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (r.key in DEFAULT_SETTINGS) (out as Record<string, unknown>)[r.key] = r.value;
  }
  return out;
}
