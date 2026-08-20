import "dotenv/config";
import createApp from "./app.js";
import { createPrismaClient } from "./database/prisma.js";
import PostgresTrustPayRepository from "./repositories/postgres-trustpay-repository.js";
import PostgresAuthService from "./auth/postgres-auth-service.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";

const prisma = createPrismaClient();
const app = await createApp({
  repository: new PostgresTrustPayRepository(prisma),
  authService: new PostgresAuthService(prisma),
  logger: true,
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:8443",
  secureCookies: process.env.NODE_ENV === "production",
});

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}
