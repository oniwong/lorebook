// Admin-editable secret detection settings (spec §8), stored in the settings table under `secretScan`.
// Built-in rules live in code (lib/secrets.ts) and can be switched off; admins can add their own regex rules
// and placeholder values.
import { getSetting, setSetting } from './settings.js';
import {
  BUILTIN_SECRET_RULES, DEFAULT_ALLOWLIST, scanSecrets, type SecretFinding, type SecretRule, type SecretScanConfig,
} from './secrets.js';
import type { StoredFinding } from '../db/schema.js';

export type CustomRule = { id: string; name: string; pattern: string; flags?: string };

export type SecretSettings = {
  disabledRules: string[];
  customRules: CustomRule[];
  allowlist: string[];
};

const KEY = 'secretScan';

export const DEFAULT_SECRET_SETTINGS: SecretSettings = { disabledRules: [], customRules: [], allowlist: DEFAULT_ALLOWLIST };

export async function getSecretSettings(): Promise<SecretSettings> {
  const stored = await getSetting<Partial<SecretSettings> | null>(KEY, null);
  return { ...DEFAULT_SECRET_SETTINGS, ...(stored ?? {}) };
}

export async function setSecretSettings(s: SecretSettings): Promise<void> {
  await setSetting(KEY, s);
}

export function toScanConfig(s: SecretSettings): SecretScanConfig {
  const disabled = new Set(s.disabledRules);
  const rules: SecretRule[] = [
    ...BUILTIN_SECRET_RULES.filter((r) => !disabled.has(r.id)),
    ...s.customRules.filter((r) => !disabled.has(r.id)).map((r) => ({ ...r, kind: 'regex' as const })),
  ];
  return { rules, allowlist: s.allowlist };
}

export async function getScanConfig(): Promise<SecretScanConfig> {
  return toScanConfig(await getSecretSettings());
}

/** What gets stored with a revision or attachment: masked previews only, never the secret. */
export function toStored(findings: SecretFinding[]): StoredFinding[] {
  return findings.map((f) => ({ ruleId: f.ruleId, ruleName: f.ruleName, line: f.line, preview: f.preview }));
}

export async function scanMarkdown(body: string): Promise<SecretFinding[]> {
  return scanSecrets(body, await getScanConfig());
}

export function scanFile(text: string, config: SecretScanConfig): SecretFinding[] {
  return scanSecrets(text, config, { allCode: true });
}
