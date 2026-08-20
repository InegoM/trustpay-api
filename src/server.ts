import "dotenv/config";
import createApp from "./app.js";
import InMemoryTrustPayRepository from "./repositories/in-memory-trustpay-repository.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";

const app = await createApp({
  repository: new InMemoryTrustPayRepository(),
  logger: true,
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:8443",
});

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
