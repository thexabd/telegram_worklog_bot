import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

let key: Buffer | null = null;

export function initCrypto(hexKey: string): void {
  const buf = Buffer.from(hexKey, 'hex');
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars). ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(${KEY_BYTES}).toString('hex'))"`,
    );
  }
  key = buf;
}

// Returns base64(iv || authTag || ciphertext) so a single column holds everything.
export function encrypt(plaintext: string): string {
  if (!key) throw new Error('Crypto not initialised. Call initCrypto first.');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(packed: string): string {
  if (!key) throw new Error('Crypto not initialised. Call initCrypto first.');
  const buf = Buffer.from(packed, 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('Encrypted payload too short.');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
