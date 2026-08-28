import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { DomainError } from "./domain/errors.js";
import type { TrustPayRepository } from "./repositories/trustpay-repository.js";
import { trustPayRoutes } from "./routes/trustpay-routes.js";
import type { AuthService } from "./auth/auth-service.js";
import { authRoutes } from "./routes/auth-routes.js";

interface CreateAppOptions {
  repository: TrustPayRepository;
  authService: AuthService;
  logger?: boolean;
  webOrigin?: string;
  secureCookies?: boolean;
}

export default async function createApp({
  repository,
  authService,
  logger = false,
  webOrigin = "http://localhost:8443",
  secureCookies = false,
}: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });

  await app.register(cors, {
    origin: webOrigin,
    methods: ["GET", "POST"],
    credentials: true,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }

    app.log.error(error);
    return reply.code(500).send({
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
    });
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "trustpay-api",
    timestamp: new Date().toISOString(),
  }));

  await app.register(authRoutes(authService, secureCookies), { prefix: "/api/v1" });
  await app.register(trustPayRoutes(repository, authService, secureCookies), { prefix: "/api/v1" });

  return app;
}
