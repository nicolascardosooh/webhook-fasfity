"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pagarmeRoutes = pagarmeRoutes;
const db_1 = require("../lib/db");
async function pagarmeRoutes(fastify) {
    fastify.post("/pagarme/webhook", async (request, reply) => {
        var _a, _b, _c;
        try {
            const body = request.body || {};
            const eventType = body.type;
            const data = body.data;
            request.log.info({
                id: body.id,
                accountId: body.account_id,
            }, `[WEBHOOK] Recebido evento: ${eventType}`);
            if (eventType === "charge.refunded" ||
                eventType === "subscription.canceled") {
                request.log.info(`[WEBHOOK] Processando cancelamento/reembolso: ${eventType}`);
                let customerDocument = (_a = data.customer) === null || _a === void 0 ? void 0 : _a.document;
                if (!customerDocument && ((_c = (_b = data.order) === null || _b === void 0 ? void 0 : _b.customer) === null || _c === void 0 ? void 0 : _c.document)) {
                    customerDocument = data.order.customer.document;
                }
                if (customerDocument) {
                    const cleanDocument = customerDocument.replace(/\D/g, "");
                    request.log.info(`[WEBHOOK] Buscando empresa com documento: ${cleanDocument}`);
                    const company = await db_1.prisma.company.findFirst({
                        where: {
                            OR: [
                                { cnpj: cleanDocument },
                                { cnpj: customerDocument },
                            ],
                        },
                    });
                    if (company) {
                        request.log.info(`[WEBHOOK] Empresa encontrada: ${company.name} (ID: ${company.id}). Desativando...`);
                        await db_1.prisma.company.update({
                            where: { id: company.id },
                            data: {
                                active: false,
                            },
                        });
                        request.log.info(`[WEBHOOK] Empresa ${company.name} desativada com sucesso.`);
                    }
                    else {
                        request.log.warn(`[WEBHOOK] Nenhuma empresa encontrada para o documento: ${cleanDocument}`);
                    }
                }
                else {
                    request.log.warn("[WEBHOOK] Documento do cliente não encontrado no payload do evento.");
                }
            }
            return reply.send({ received: true });
        }
        catch (error) {
            request.log.error(`[WEBHOOK] Erro ao processar webhook: ${error}`);
            return reply.code(500).send({ error: "Internal Server Error" });
        }
    });
}
//# sourceMappingURL=pagarme.js.map