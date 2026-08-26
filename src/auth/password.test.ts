import { describe, expect, it } from "vitest";
import { PASSWORD_HASHING_CONFIG, hashPassword, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("creates salted scrypt credentials without storing the plaintext password", async () => {
    const password = "CorrectHorseBatteryStaple!2026";
    const first = await hashPassword(password);
    const second = await hashPassword(password);

    expect(PASSWORD_HASHING_CONFIG).toMatchObject({
      algorithm: "scrypt",
      cost: 16_384,
      blockSize: 8,
      parallelization: 1,
      keyLength: 64,
    });
    expect(first.hash).not.toContain(password);
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
    await expect(verifyPassword(password, first.salt, first.hash)).resolves.toBe(true);
    await expect(verifyPassword("WrongPassword!2026", first.salt, first.hash)).resolves.toBe(false);
  });
});
