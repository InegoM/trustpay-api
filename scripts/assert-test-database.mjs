import "dotenv/config";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required. Start the isolated test database with `npm run db:test:up`, then run `npm run db:test:deploy` and `npm run db:test:seed`.",
  );
}

const url = new URL(testDatabaseUrl);
if (!url.pathname.replace(/^\//, "").startsWith("trustpay_test")) {
  throw new Error("TEST_DATABASE_URL must target the isolated trustpay_test database.");
}
