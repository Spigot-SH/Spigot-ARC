import crypto from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

const getKey = (): Buffer => {
  if (cachedKey) return cachedKey;
  const raw = config.MASTER_ENCRYPTION_KEY;
  if (!raw) throw new Error('MASTER_ENCRYPTION_KEY is not configured');

  // Accept a 32-byte hex key, otherwise derive one so short keys still yield 256 bits.
  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : crypto.createHash('sha256').update(raw).digest();

  cachedKey = key;
  return key;
};

/**
 * Encrypt a custodial secret at rest. Output layout: iv | authTag | ciphertext (base64).
 * Callers must never log or return the plaintext.
 */
export const encryptSecret = (plaintext: string): string => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
};

export const decryptSecret = (payload: string): string => {
  const buf = Buffer.from(payload, 'base64');
  if (buf.length <= IV_LENGTH + AUTH_TAG_LENGTH) throw new Error('Malformed encrypted payload');

  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};

/** Constant-time comparison for tokens and OTP codes. */
export const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/** SHA-256 hex digest — used to store magic-link tokens and OTP codes without keeping the plaintext. */
export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');
