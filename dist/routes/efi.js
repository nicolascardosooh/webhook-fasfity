import { prisma } from "../lib/db.js";
import { efiService } from "../services/efiService.js";
import { workerService } from "../services/workerService.js";
export async function efiRoutes(fastify) {
    fastify.get("/webhooks/efi", async (request, reply) => {
        return reply.send({ ok: true, message: "EFI Webhook Active" });
    });
    fastify.post("/webhooks/efi", async (request, reply) => {
        var _a, _b;
        try {
            const contentType = request.headers["content-type"] || "";
            let notificationToken = null;
            let bodyData = {};
            request.log.info(`[EFI Webhook] Content-Type: ${contentType}`);
            if (contentType.includes("application/json")) {
                bodyData = request.body || {};
                notificationToken = bodyData.notification || null;
                request.log.info(`[EFI Webhook] JSON Body: ${JSON.stringify(bodyData, null, 2)}`);
            }
            else if (contentType.includes("application/x-www-form-urlencoded")) {
                bodyData = request.body || {};
                notificationToken = bodyData.notification || null;
                request.log.info(`[EFI Webhook] Form Data Body: ${JSON.stringify(bodyData, null, 2)}`);
            }
            else {
                request.log.warn(`[EFI Webhook] Unknown Content-Type: ${contentType}`);
            }
            if (!notificationToken) {
                request.log.warn("[EFI Webhook] Recebido POST sem token de notificação.");
                return reply.code(200).send({ ok: true, message: "Token não fornecido" });
            }
            const alreadyProcessed = await prisma.efiWebhookProcessed.findUnique({
                where: { notificationToken },
            });
            if (alreadyProcessed) {
                request.log.info(`[EFI Webhook] ⏩ Notificação ignorada: Já processada anteriormente (Token: ${notificationToken})`);
                return reply.code(200).send({ ok: true, message: "Notificação já processada" });
            }
            request.log.info(`[EFI Webhook] 📥 Iniciando processamento do token: ${notificationToken}`);
            const notificationDetails = await efiService.getNotification(notificationToken);
            const lastEvent = (_a = notificationDetails.data) === null || _a === void 0 ? void 0 : _a[notificationDetails.data.length - 1];
            if (!lastEvent) {
                request.log.warn("[EFI Webhook] ⚠️ Nenhum evento encontrado nos detalhes da notificação.");
                return reply.code(400).send({ ok: false, message: "Dados da notificação vazios" });
            }
            const events = notificationDetails.data || [];
            const allStatuses = events.map((e) => { var _a; return (_a = e.status) === null || _a === void 0 ? void 0 : _a.current; }).join(", ");
            request.log.info(`[EFI Webhook] 📊 Status recebidos na notificação: [${allStatuses}]`);
            const hasPaidEvent = events.some((e) => ["paid", "settled"].includes(e.status.current));
            const hasActiveEvent = events.some((e) => e.status.current === "active" && e.type === "subscription");
            const subscription_id = (_b = lastEvent.identifiers) === null || _b === void 0 ? void 0 : _b.subscription_id;
            const invoiceIdFromMetadata = lastEvent.custom_id;
            request.log.info(`[EFI Webhook] 🔍 Contexto: Assinatura ID=${subscription_id} | Referência (Invoice)=${invoiceIdFromMetadata} | Pago=${hasPaidEvent} | Ativo=${hasActiveEvent}`);
            if (hasPaidEvent || hasActiveEvent) {
                request.log.info(`[EFI Webhook] 🔎 Status elegível. Buscando fatura no banco local...`);
                const invoice = await prisma.invoice.findFirst({
                    where: {
                        OR: [
                            { id: invoiceIdFromMetadata },
                            { externalId: String(subscription_id) },
                            { payments: { some: { gatewayRef: String(subscription_id) } } },
                        ],
                    },
                });
                if (!invoice) {
                    request.log.warn(`[EFI Webhook] Cobrança/Assinatura ${subscription_id} (Ref: ${invoiceIdFromMetadata}) não encontrada no banco local.`);
                    return reply.send({
                        ok: true,
                        message: "Notificação ignorada (não encontrada localmente)",
                    });
                }
                const subscription = await prisma.subscription.findUnique({
                    where: { id: invoice.subscriptionId },
                    include: { plan: true },
                });
                if (!subscription) {
                    request.log.error(`[EFI Webhook] ERRO DE INTEGRIDADE: Assinatura ${invoice.subscriptionId} não encontrada para a fatura ${invoice.id}`);
                    return reply.code(404).send({ ok: false, message: "Assinatura não encontrada" });
                }
                const company = await prisma.company.findUnique({
                    where: { id: subscription.companyId },
                    include: {
                        users: {
                            where: { role: "ADMIN" },
                            take: 1,
                        },
                    },
                });
                if (!company) {
                    request.log.error(`[EFI Webhook] ERRO DE INTEGRIDADE: Empresa ${subscription.companyId} não encontrada para a assinatura ${subscription.id}`);
                    return reply.code(404).send({ ok: false, message: "Empresa não encontrada" });
                }
                const adminUser = company.users[0];
                if (!adminUser) {
                    request.log.error(`[EFI Webhook] Usuário ADMIN não encontrado para a empresa ${company.id}`);
                    return reply.code(500).send({ ok: false, message: "Admin não encontrado" });
                }
                const shouldActivateAccess = hasPaidEvent;
                const shouldProvision = hasPaidEvent && !company.databaseName;
                request.log.info(`[EFI Webhook] 🧠 Decisão Lógica: HasPaid=${hasPaidEvent} | DatabaseName='${company.databaseName || 'null'}'`);
                request.log.info(`[EFI Webhook] 🎯 Ação Final: Ativar Acesso? ${shouldActivateAccess ? '✅ SIM' : '❌ NÃO'} | Provisionar Banco? ${shouldProvision ? '✅ SIM' : '❌ NÃO'}`);
                await prisma.$transaction(async (tx) => {
                    if (shouldActivateAccess) {
                        await tx.invoice.update({
                            where: { id: invoice.id },
                            data: {
                                status: "paid",
                                paidAt: new Date(),
                            },
                        });
                        await tx.payment.updateMany({
                            where: { invoiceId: invoice.id },
                            data: {
                                status: "captured",
                                updatedAt: new Date(),
                            },
                        });
                        await tx.company.update({
                            where: { id: company.id },
                            data: { active: true },
                        });
                        await tx.user.update({
                            where: { id: adminUser.id },
                            data: { active: true },
                        });
                        await tx.subscription.update({
                            where: { id: subscription.id },
                            data: {
                                status: "active",
                                ...(subscription.status !== "active"
                                    ? {
                                        nextDueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                                    }
                                    : {}),
                            },
                        });
                        request.log.info(`[EFI Webhook] 🔓 ACESSO LIBERADO: Empresa ${company.name} e Assinatura ${subscription.id} ATIVADOS.`);
                    }
                });
                if (shouldProvision) {
                    try {
                        request.log.info(`[EFI Webhook] 🚀 Iniciando PROVISIONAMENTO para ${company.name}...`);
                        const workerRes = await workerService.provisionDatabase(company.id);
                        if (workerRes.ok) {
                            request.log.info(`[EFI Webhook] ✅ Provisionamento enfileirado no Worker com sucesso.`);
                        }
                        else {
                            request.log.error(`[EFI Webhook] ❌ Erro ao enfileirar no Worker: ${workerRes.error}`);
                        }
                    }
                    catch (err) {
                        request.log.error(`[EFI Webhook] 💥 EXCEÇÃO ao chamar Worker: ${err}`);
                    }
                }
                const nfseEmitenteCnpj = (process.env.NFSE_EMITENTE_CNPJ || "63132343000120")
                    .replace(/\D/g, "")
                    .padStart(14, "0")
                    .slice(-14);
                const nfseEmitenteCompany = nfseEmitenteCnpj
                    ? await prisma.company.findFirst({
                        where: { cnpj: nfseEmitenteCnpj, databaseName: { not: null } },
                    })
                    : null;
                const nfseCompanyId = (nfseEmitenteCompany === null || nfseEmitenteCompany === void 0 ? void 0 : nfseEmitenteCompany.id) || company.id;
                if (hasPaidEvent &&
                    !invoice.nfseEnqueuedAt &&
                    nfseCompanyId &&
                    (nfseEmitenteCompany ? true : !!company.databaseName)) {
                    try {
                        const nfseRes = await workerService.dispatchNFSe({
                            operation: "emitirAutoNFSe",
                            companyId: nfseCompanyId,
                            invoiceId: invoice.id,
                            includeWelcome: shouldProvision,
                        });
                        if (nfseRes.ok) {
                            await prisma.invoice.update({
                                where: { id: invoice.id },
                                data: { nfseEnqueuedAt: new Date() },
                            });
                            request.log.info(`[EFI Webhook] NFSe enfileirada para emissão e e-mail ao cliente.`);
                        }
                        else {
                            request.log.error(`[EFI Webhook] Erro ao enfileirar NFSe: ${nfseRes.error}`);
                        }
                    }
                    catch (err) {
                        request.log.error(`[EFI Webhook] EXCEÇÃO ao enfileirar NFSe: ${err}`);
                    }
                }
                else if (hasPaidEvent &&
                    !invoice.nfseEnqueuedAt &&
                    !nfseEmitenteCompany &&
                    !company.databaseName) {
                    request.log.info(`[EFI Webhook] NFSe não enfileirada: tenant ainda não provisionado (company ${company.id}).`);
                }
                if (shouldActivateAccess || shouldProvision) {
                    await prisma.efiWebhookProcessed.create({
                        data: {
                            notificationToken,
                            invoiceId: invoice.id,
                        },
                    });
                    request.log.info(`[EFI Webhook] 🔒 Processamento concluído com ações. Token de notificação salvo para idempotência.`);
                }
                else {
                    request.log.info(`[EFI Webhook] ⏳ Nenhuma ação tomada (aguardando pagamento). Token não salvo para permitir retentativas/atualizações.`);
                }
                return reply.send({ ok: true });
            }
            request.log.info(`[EFI Webhook] 🛑 Eventos ignorados (Status irrelevantes para ativação).`);
            return reply.send({ ok: true, message: "Status ignorado" });
        }
        catch (error) {
            request.log.error(`[EFI Webhook] 🚨 ERRO CRÍTICO: ${JSON.stringify(error, null, 2)}`);
            return reply.code(500).send({
                ok: false,
                message: "Erro interno no processamento do webhook",
            });
        }
    });
}
//# sourceMappingURL=efi.js.map