import "dotenv/config";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required to seed the test database.");
}

const url = new URL(testDatabaseUrl);
if (!url.pathname.replace(/^\//, "").startsWith("trustpay_test")) {
  throw new Error("TEST_DATABASE_URL must target the isolated trustpay_test database.");
}

process.env.DATABASE_URL = testDatabaseUrl;
await import("../prisma/seed.ts");
