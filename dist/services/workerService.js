import amqp from "amqplib";
import { prisma } from "../lib/db.js";
import { qualifyRabbitName } from "../lib/rabbitmqTopology.js";
export const workerService = {
    dispatchProvision: async (data) => {
        const rabbitUrl = process.env.RABBITMQ_URL;
        if (!rabbitUrl) {
            console.warn("RABBITMQ_URL não configurada no ambiente. Pulando despacho.");
            return { ok: true, message: "RABBITMQ_URL não configurada (mock mode)" };
        }
        try {
            console.log(`[WorkerService] Conectando ao RabbitMQ em ${rabbitUrl}...`);
            const connection = await amqp.connect(rabbitUrl);
            const channel = await connection.createConfirmChannel();
            const exchange = qualifyRabbitName("infra.setup");
            const routingKey = qualifyRabbitName("create-tenant");
            await channel.assertExchange(exchange, "direct", { durable: true });
            console.log(`[WorkerService] Publicando provisionamento para ${data.tenant_name}...`);
            const published = channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(data)), { persistent: true });
            if (!published) {
                throw new Error("Falha ao publicar mensagem no RabbitMQ (buffer cheio?)");
            }
            await channel.waitForConfirms();
            await channel.close();
            await connection.close();
            console.log(`[WorkerService] Mensagem enviada com sucesso para o RabbitMQ.`);
            return { ok: true };
        }
        catch (error) {
            console.error("[WorkerService] Falha ao enviar para o RabbitMQ:", error);
            return {
                ok: false,
                error: error instanceof Error ? error.message : "Erro desconhecido",
            };
        }
    },
    provisionDatabase: async (companyId) => {
        var _a, _b, _c, _d;
        try {
            const company = await prisma.company.findUnique({
                where: { id: companyId },
                include: {
                    users: { where: { role: "ADMIN" }, take: 1 },
                    subscriptions: { include: { plan: true } },
                },
            });
            if (!company)
                throw new Error("Empresa não encontrada");
            const admin = (_a = company.users) === null || _a === void 0 ? void 0 : _a[0];
            if (!admin)
                throw new Error("Admin não encontrado");
            const subscription = (_b = company.subscriptions) === null || _b === void 0 ? void 0 : _b[0];
            const moduleKeys = (subscription === null || subscription === void 0 ? void 0 : subscription.moduleKeys) || [];
            console.log(`[WorkerService] Assinatura encontrada: ${(subscription === null || subscription === void 0 ? void 0 : subscription.id) || "Nenhuma"}`);
            console.log(`[WorkerService] ModuleKeys encontrados:`, JSON.stringify(moduleKeys));
            let tenantName = company.databaseName;
            let tenantPass = company.databasePass;
            if (!tenantName) {
                const slug = company.name
                    .toLowerCase()
                    .normalize("NFD")
                    .replace(/[\u0300-\u036f]/g, "")
                    .replace(/[^a-z0-z0-9]/g, "_")
                    .substring(0, 20);
                tenantName = `db_${slug}_${company.id.substring(0, 4)}`;
            }
            if (!tenantPass) {
                tenantPass =
                    Math.random().toString(36).slice(-8) +
                        Math.random().toString(36).slice(-8);
            }
            const allActiveModules = await prisma.management.findMany({
                where: { active: true },
                select: { id: true, name: true, key: true, priceCents: true },
            });
            const planKey = (_c = subscription === null || subscription === void 0 ? void 0 : subscription.plan) === null || _c === void 0 ? void 0 : _c.key;
            const freeModuleIds = allActiveModules
                .filter((m) => m.priceCents === 0)
                .map((m) => m.id);
            const planInclusionIds = [];
            if (planKey === "avancado") {
                const matchingIds = allActiveModules
                    .filter((m) => m.key === "vendas_pdv" ||
                    m.key === "emissao_nfce" ||
                    m.name.includes("Vendas") ||
                    m.name.includes("NFC-e"))
                    .map((m) => m.id);
                planInclusionIds.push(...matchingIds);
            }
            const consolidatedIds = Array.from(new Set([...moduleKeys, ...freeModuleIds, ...planInclusionIds]));
            const resolvedModules = allActiveModules
                .filter((m) => consolidatedIds.includes(m.id))
                .map((m) => m.key || m.name);
            console.log(`[WorkerService] IDs consolidados (${consolidatedIds.length}):`, JSON.stringify(consolidatedIds));
            console.log(`[WorkerService] Módulos finais para o Worker:`, JSON.stringify(resolvedModules));
            const payload = {
                company_id: companyId,
                tenant_name: tenantName,
                admin_email: admin.email,
                admin_password_hash: admin.password,
                database_password: tenantPass,
                plano_escolhido: ((_d = subscription === null || subscription === void 0 ? void 0 : subscription.plan) === null || _d === void 0 ? void 0 : _d.name) || "plano_padrao",
                modulos_contratados: resolvedModules,
            };
            console.log(`[WorkerService] Payload enviado ao Worker:`, JSON.stringify({
                ...payload,
                admin_password_hash: "***",
                database_password: "***",
            }, null, 2));
            const dispatchResult = await workerService.dispatchProvision(payload);
            return dispatchResult;
        }
        catch (error) {
            console.error("[WorkerService] Erro no provisionamento:", error);
            return {
                ok: false,
                error: error instanceof Error ? error.message : "Erro desconhecido",
            };
        }
    },
    dispatchNFSe: async (payload) => {
        const rabbitUrl = process.env.RABBITMQ_URL;
        if (!rabbitUrl) {
            console.warn("RABBITMQ_URL não configurada. Pulando despacho NFSe.");
            return { ok: true, message: "RABBITMQ_URL não configurada (mock)" };
        }
        try {
            const connection = await amqp.connect(rabbitUrl);
            const channel = await connection.createChannel();
            const exchange = qualifyRabbitName("docs.authorization");
            const routingKey = qualifyRabbitName("nfse.process");
            await channel.assertExchange(exchange, "direct", { durable: true });
            const published = channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(payload)), { persistent: true });
            await channel.close();
            await connection.close();
            if (!published)
                throw new Error("Falha ao publicar mensagem NFSe no RabbitMQ");
            console.log("[WorkerService] NFSe publicada na fila com sucesso.");
            return { ok: true };
        }
        catch (error) {
            console.error("[WorkerService] Falha ao enviar NFSe para o RabbitMQ:", error);
            return {
                ok: false,
                error: error instanceof Error ? error.message : "Erro desconhecido",
            };
        }
    },
};
//# sourceMappingURL=workerService.js.map