import "dotenv/config";
import Fastify from "fastify";
import formBody from "@fastify/formbody";
import { efiRoutes } from "./routes/efi.js";

const fastify = Fastify({
  logger: true,
});

// Registrar plugin para suportar application/x-www-form-urlencoded
fastify.register(formBody);

fastify.get("/health", async () => {
  return { ok: true, message: "webhooks-fastify está rodando" };
});

// Registrar rotas com prefixo /api (ex: /api/webhooks/efi)
fastify.register(efiRoutes, { prefix: "/api" });

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
