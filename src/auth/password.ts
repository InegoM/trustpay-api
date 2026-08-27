import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

export const PASSWORD_HASHING_CONFIG = {
  algorithm: "scrypt",
  cost: 16_384,
  blockSize: 8,
  parallelization: 1,
  keyLength: 64,
  maxMemoryBytes: 64 * 1024 * 1024,
} as const;

const SCRYPT_OPTIONS = {
  N: PASSWORD_HASHING_CONFIG.cost,
  r: PASSWORD_HASHING_CONFIG.blockSize,
  p: PASSWORD_HASHING_CONFIG.parallelization,
  maxmem: PASSWORD_HASHING_CONFIG.maxMemoryBytes,
};

function deriveKey(password: string, salt: string, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<{
  hash: string;
  salt: string;
}> {
  const salt = randomBytes(16).toString("base64url");
  const derived = await deriveKey(password, salt, PASSWORD_HASHING_CONFIG.keyLength);
  return { hash: derived.toString("base64url"), salt };
}

export async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string,
): Promise<boolean> {
  const expected = Buffer.from(expectedHash, "base64url");
  const actual = await deriveKey(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
