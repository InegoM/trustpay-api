import { hrtime } from "node:process";
import { PASSWORD_HASHING_CONFIG, hashPassword, verifyPassword } from "../src/auth/password.js";

const password = "BenchmarkOnlyPassword!2026";
const startedAt = hrtime.bigint();
const credential = await hashPassword(password);
const elapsedMilliseconds = Number(hrtime.bigint() - startedAt) / 1_000_000;

if (!(await verifyPassword(password, credential.salt, credential.hash))) {
  throw new Error("Password benchmark verification failed.");
}

console.log(
  JSON.stringify({
    algorithm: PASSWORD_HASHING_CONFIG.algorithm,
    cost: PASSWORD_HASHING_CONFIG.cost,
    blockSize: PASSWORD_HASHING_CONFIG.blockSize,
    parallelization: PASSWORD_HASHING_CONFIG.parallelization,
    keyLength: PASSWORD_HASHING_CONFIG.keyLength,
    elapsedMilliseconds: Number(elapsedMilliseconds.toFixed(1)),
  }),
);
