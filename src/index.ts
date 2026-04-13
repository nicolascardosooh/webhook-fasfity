import "dotenv/config";
import Fastify from "fastify";
import formBody from "@fastify/formbody";
import { efiRoutes } from "./routes/efi.js";
import { controlpayRoutes } from "./routes/controlpay.js";

const usePrettyLogs =
  process.env.NODE_ENV !== "production" && process.env.LOG_JSON !== "1";

const fastify = Fastify({
  logger: usePrettyLogs
    ? {
        level: (process.env.LOG_LEVEL as "info" | "warn" | "error") ?? "info",
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }
    : { level: "info" },
});

/**
 * ControlPay notifica com Content-Type application/json e corpo vazio;
 * o Fastify padrão rejeita (FST_ERR_CTP_EMPTY_JSON_BODY → 400).
 */
fastify.removeContentTypeParser("application/json");
fastify.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  function (_req, body, done) {
    const raw = typeof body === "string" ? body : String(body ?? "");
    if (raw.trim() === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (e) {
      done(e as Error, undefined);
    }
  },
);

// Registrar plugin para suportar application/x-www-form-urlencoded
fastify.register(formBody);

fastify.get("/health", async () => {
  return { ok: true, message: "webhooks-fastify está rodando" };
});

// Registrar rotas com prefixo /api (ex: /api/webhooks/efi)
fastify.register(efiRoutes, { prefix: "/api" });
fastify.register(controlpayRoutes, { prefix: "/api" });

async function start() {
  try {
    const port = 4000;
    const host = "0.0.0.0";
    await fastify.listen({ port, host });
    console.log(`Server listening on http://${host}:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
