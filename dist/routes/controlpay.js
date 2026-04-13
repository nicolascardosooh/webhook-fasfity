import { prismaCore, getClientDatabase, PrismaClientKnownRequestError, } from "@repo/db";
import { createControlPayWebhookEventAndScheduleHydrate } from "../services/controlpayWebhookService.js";
import { printControlPayWebhookBanner } from "../lib/controlPayWebhookBanner.js";
function flattenQuery(q) {
    if (!q || typeof q !== "object")
        return {};
    const out = {};
    for (const [k, v] of Object.entries(q)) {
        if (v == null)
            continue;
        if (Array.isArray(v)) {
            const first = v[0];
            if (first != null)
                out[k] = String(first);
        }
        else {
            out[k] = String(v);
        }
    }
    return out;
}
function buildControlpayWebhookPayload(request) {
    var _a;
    const flatQ = flattenQuery(request.query);
    let bodyRaw = request.body;
    if (typeof bodyRaw === "string") {
        try {
            bodyRaw = JSON.parse(bodyRaw);
        }
        catch (_b) {
            bodyRaw = { raw: bodyRaw };
        }
    }
    const bodyObj = bodyRaw && typeof bodyRaw === "object" && !Array.isArray(bodyRaw)
        ? bodyRaw
        : {};
    const merged = { ...flatQ, ...bodyObj };
    const refAlt = (_a = merged.intencaoVendaReferencia) !== null && _a !== void 0 ? _a : merged.IntencaoVendaReferencia;
    if (refAlt != null &&
        String(refAlt).trim() !== "" &&
        (merged.referencia == null || String(merged.referencia).trim() === "")) {
        merged.referencia = String(refAlt);
    }
    return merged;
}
export async function controlpayRoutes(fastify) {
    fastify.post("/webhooks/controlpay/:coreCompanyId", async (request, reply) => {
        const t0 = Date.now();
        const { coreCompanyId } = request.params;
        const q = flattenQuery(request.query);
        const company = await prismaCore.company.findUnique({
            where: { id: coreCompanyId },
        });
        if (!(company === null || company === void 0 ? void 0 : company.databaseName)) {
            printControlPayWebhookBanner({
                phase: "start",
                coreCompanyId,
                intencaoVendaId: q.intencaoVendaId,
                referencia: q.intencaoVendaReferencia,
                remoteIp: request.ip,
            });
            printControlPayWebhookBanner({
                phase: "err",
                httpStatus: 404,
                code: "company_not_found",
                message: "Empresa não encontrada no Core ou sem databaseName (tenant não provisionado).",
                ms: Date.now() - t0,
            });
            return reply.status(404).send({ ok: false, error: "Empresa não encontrada" });
        }
        printControlPayWebhookBanner({
            phase: "start",
            coreCompanyId,
            databaseName: company.databaseName,
            intencaoVendaId: q.intencaoVendaId,
            referencia: q.intencaoVendaReferencia,
            remoteIp: request.ip,
        });
        const payload = buildControlpayWebhookPayload({
            body: request.body,
            query: request.query,
        });
        try {
            const tenant = await getClientDatabase(coreCompanyId);
            const { eventId, skippedDuplicate } = await createControlPayWebhookEventAndScheduleHydrate({
                tenant,
                coreCompanyId,
                payload,
            });
            printControlPayWebhookBanner({
                phase: "ok",
                eventId,
                skippedDuplicate,
                ms: Date.now() - t0,
            });
            return reply.send({ ok: true, eventId, skippedDuplicate });
        }
        catch (e) {
            const ms = Date.now() - t0;
            if (e instanceof PrismaClientKnownRequestError && e.code === "P1000") {
                const hint = "Postgres recusou usuário/senha no tenant. Copie DATABASE_URL e CLIENT_DATABASE_URL do gestaowebprisma/.env para webhooks-fastify/.env, ou use Company.databasePass no Core.";
                printControlPayWebhookBanner({
                    phase: "err",
                    httpStatus: 500,
                    code: "P1000",
                    message: "Falha de autenticação no PostgreSQL (tenant).",
                    hint,
                    ms,
                });
                return reply.status(500).send({
                    ok: false,
                    error: "database_auth_failed",
                    code: e.code,
                    hint,
                });
            }
            request.log.error(e);
            const message = e instanceof Error ? e.message : "erro";
            printControlPayWebhookBanner({
                phase: "err",
                httpStatus: 500,
                message,
                ms,
            });
            return reply.status(500).send({ ok: false, error: message });
        }
    });
}
//# sourceMappingURL=controlpay.js.map