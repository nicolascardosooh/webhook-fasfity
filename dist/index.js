"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const formbody_1 = __importDefault(require("@fastify/formbody"));
const efi_1 = require("./routes/efi");
const fastify = (0, fastify_1.default)({
    logger: true,
});
fastify.register(formbody_1.default);
fastify.get("/health", async () => {
    return { ok: true, message: "webhooks-fastify está rodando" };
});
fastify.register(efi_1.efiRoutes);
async function start() {
    try {
        const port = 4000;
        const host = "0.0.0.0";
        await fastify.listen({ port, host });
        console.log(`Server listening on http://${host}:${port}`);
    }
    catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
}
start();
//# sourceMappingURL=index.js.map