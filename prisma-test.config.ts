import "dotenv/config";
import { defineConfig } from "prisma/config";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for test database commands.");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "node --import tsx scripts/seed-test-database.mjs",
  },
  datasource: { url: testDatabaseUrl },
});
