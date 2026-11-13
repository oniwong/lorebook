import { hash, verify, Algorithm } from '@node-rs/argon2';

export const MIN_PASSWORD_LENGTH = 12;

export function validatePassword(pw: string): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (pw.length > 1024) return 'Password is too long';
  return null;
}

export function hashPassword(pw: string): Promise<string> {
  return hash(pw, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(stored: string, pw: string): Promise<boolean> {
  try {
    return await verify(stored, pw);
  } catch {
    return false;
  }
}

// A real hash to verify against when the user doesn't exist, so timing doesn't reveal valid usernames.
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('lorebook-dummy-password-for-timing');
  return dummy;
}
