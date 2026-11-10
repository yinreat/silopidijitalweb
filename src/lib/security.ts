const MASTER_KEY = 'propos-master-password-v1';
const PBKDF2_ITERATIONS = 120000;

type StoredSecret = { salt: string; hash: string; iterations: number };

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}
function b64ToBytes(input: string): Uint8Array {
  const binary = atob(input);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

async function hashPassword(password: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const safeSalt = new Uint8Array(salt).buffer;
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: safeSalt, iterations, hash: 'SHA-256' }, baseKey, 256);
  return bytesToB64(new Uint8Array(bits));
}

export function hasMasterPassword(): boolean {
  try { return Boolean(localStorage.getItem(MASTER_KEY)); } catch { return false; }
}

export async function setMasterPassword(password: string): Promise<void> {
  if (password.length < 6) throw new Error('Şifre en az 6 karakter olmalı.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, salt);
  const stored: StoredSecret = { salt: bytesToB64(salt), hash, iterations: PBKDF2_ITERATIONS };
  localStorage.setItem(MASTER_KEY, JSON.stringify(stored));
}

export async function verifyMasterPassword(password: string): Promise<boolean> {
  try {
    const raw = localStorage.getItem(MASTER_KEY);
    if (!raw) return false;
    const stored = JSON.parse(raw) as StoredSecret;
    const actual = await hashPassword(password, b64ToBytes(stored.salt), stored.iterations || PBKDF2_ITERATIONS);
    return actual === stored.hash;
  } catch { return false; }
}
