import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { DomainError } from "./domain/errors.js";
import type { TrustPayRepository } from "./repositories/trustpay-repository.js";
import { trustPayRoutes } from "./routes/trustpay-routes.js";
import type { AuthService } from "./auth/auth-service.js";
import { authRoutes } from "./routes/auth-routes.js";
import EvidenceService from "./evidence/evidence-service.js";
import { InMemoryObjectStorage } from "./storage/object-storage.js";
import { AllowAllTestScanner } from "./storage/malware-scanner.js";

interface CreateAppOptions {
  repository: TrustPayRepository;
  authService: AuthService;
  logger?: boolean;
  webOrigin?: string;
  secureCookies?: boolean;
  evidenceService?: EvidenceService;
}

export default async function createApp({
  repository,
  authService,
  logger = false,
  webOrigin = "http://localhost:8443",
  secureCookies = false,
  evidenceService = new EvidenceService(repository, new InMemoryObjectStorage(), new AllowAllTestScanner()),
}: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });

  await app.register(cors, {
    origin: webOrigin,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    credentials: true,
  });
  await app.register(multipart, {
    limits: { files: 1, fields: 6, fileSize: 10 * 1024 * 1024 },
  });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }

    if (error && typeof error === "object" && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE") {
      return reply.code(413).send({
        error: { code: "EVIDENCE_FILE_TOO_LARGE", message: "Files must be 10 MB or smaller" },
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
  await app.register(trustPayRoutes(repository, authService, evidenceService, secureCookies), { prefix: "/api/v1" });

  return app;
}
