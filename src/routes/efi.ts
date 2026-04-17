import { FastifyInstance } from "fastify";
import { prisma } from "../lib/db.js";
import { efiService } from "../services/efiService.js";
import { workerService } from "../services/workerService.js";

export async function efiRoutes(fastify: FastifyInstance) {
  fastify.get("/webhooks/efi", async (request, reply) => {
    return reply.send({ ok: true, message: "EFI Webhook Active" });
  });

  fastify.post("/webhooks/efi", async (request, reply) => {
    try {
      const contentType = request.headers["content-type"] || "";
      let notificationToken: string | null = null;
      let bodyData: any = {};

      request.log.info(`[EFI Webhook] Content-Type: ${contentType}`);

      if (contentType.includes("application/json")) {
        bodyData = request.body || {};
        notificationToken = bodyData.notification || null;
        request.log.info(
          `[EFI Webhook] JSON Body: ${JSON.stringify(bodyData, null, 2)}`
        );
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        bodyData = request.body || {};
        notificationToken = bodyData.notification || null;
        request.log.info(
          `[EFI Webhook] Form Data Body: ${JSON.stringify(bodyData, null, 2)}`
        );
      } else {
        // Fallback for raw/text body if needed, but Fastify usually parses known types
        request.log.warn(`[EFI Webhook] Unknown Content-Type: ${contentType}`);
        // Tentar extrair token de query params ou raw body se disponível (Fastify não expõe raw body por padrão sem config)
      }

      if (!notificationToken) {
        request.log.warn("[EFI Webhook] Recebido POST sem token de notificação.");
        return reply.code(200).send({ ok: true, message: "Token não fornecido" });
      }

      // Idempotência: não processar o mesmo webhook duas vezes
      const alreadyProcessed = await prisma.efiWebhookProcessed.findUnique({
        where: { notificationToken },
      });
      if (alreadyProcessed) {
        request.log.info(`[EFI Webhook] ⏩ Notificação ignorada: Já processada anteriormente (Token: ${notificationToken})`);
        return reply.code(200).send({ ok: true, message: "Notificação já processada" });
      }

      request.log.info(`[EFI Webhook] 📥 Iniciando processamento do token: ${notificationToken}`);

      // 1. Validar notificação na EFI
      const notificationDetails = await efiService.getNotification(
        notificationToken
      );

      // O retorno do getNotification é um array de eventos no campo 'data'
      const lastEvent =
        notificationDetails.data?.[notificationDetails.data.length - 1];

      if (!lastEvent) {
        request.log.warn("[EFI Webhook] ⚠️ Nenhum evento encontrado nos detalhes da notificação.");
        return reply.code(400).send({ ok: false, message: "Dados da notificação vazios" });
      }

      // Na EFI, o subscription_id fica dentro de 'identifiers'
      // E o custom_id (que mandamos como invoiceId) fica na raiz do evento
      const events = notificationDetails.data || [];

      // Mapear todos os status recebidos para o log
      const allStatuses = events.map((e: any) => e.status?.current).join(", ");
      request.log.info(`[EFI Webhook] 📊 Status recebidos na notificação: [${allStatuses}]`);

      // Verificar se há algum evento de pagamento confirmado nos dados
      const hasPaidEvent = events.some((e: any) =>
        ["paid", "settled"].includes(e.status?.current)
      );
      // Verificar se a assinatura foi marcada como ativa
      const hasActiveEvent = events.some(
        (e: any) => e.status?.current === "active" && e.type === "subscription"
      );

      const subscription_id = lastEvent.identifiers?.subscription_id;
      const pickChargeId = (): number | undefined => {
        for (const e of events) {
          const raw =
            e?.identifiers?.charge_id ??
            e?.identifiers?.chargeId ??
            e?.charge_id;
          const n = Number(raw);
          if (Number.isFinite(n)) return n;
        }
        return undefined;
      };
      const charge_id = pickChargeId();
      const invoiceIdFromMetadata = lastEvent.custom_id;

      request.log.info(
        `[EFI Webhook] 🔍 Contexto: subscription_id=${subscription_id} | charge_id=${charge_id} | custom_id=${invoiceIdFromMetadata} | Pago=${hasPaidEvent} | Ativo=${hasActiveEvent}`
      );

      // 2. Verificar se o status é pago OU ativo (para provisionamento antecipado)
      if (hasPaidEvent || hasActiveEvent) {
        const customRef =
          invoiceIdFromMetadata != null ? String(invoiceIdFromMetadata) : "";

        // Pacote extra fiscal: custom_id = fpx_<uuid> (legado homolog: fpx:)
        if (customRef.startsWith("fpx_") || customRef.startsWith("fpx:")) {
          if (!hasPaidEvent) {
            request.log.info(
              `[EFI Webhook] fpx aguardando confirmação de pagamento (${customRef})`,
            );
            return reply.send({ ok: true, message: "Aguardando pagamento" });
          }

          const packOrder = await prisma.fiscalExtraPackOrder.findFirst({
            where: { efiCustomId: customRef },
          });

          if (!packOrder) {
            request.log.warn(
              `[EFI Webhook] Pedido pacote extra não encontrado: ${customRef}`,
            );
            return reply.send({
              ok: true,
              message: "fpx não encontrado localmente",
            });
          }

          const extraInvoice = await prisma.invoice.findFirst({
            where: { fiscalExtraPackOrderId: packOrder.id },
          });

          if (!extraInvoice) {
            request.log.error(
              `[EFI Webhook] fpx sem Invoice para pedido ${packOrder.id}`,
            );
            return reply.code(404).send({ ok: false, message: "Fatura extra não encontrada" });
          }

          await prisma.$transaction(async (tx) => {
            await tx.fiscalExtraPackOrder.update({
              where: { id: packOrder.id },
              data: { status: "paid", paidAt: new Date() },
            });
            await tx.invoice.update({
              where: { id: extraInvoice.id },
              data: { status: "paid", paidAt: new Date() },
            });
            await tx.payment.updateMany({
              where: { invoiceId: extraInvoice.id },
              data: { status: "captured", updatedAt: new Date() },
            });
          });

          if (!packOrder.webhookCreditedAt) {
            const creditRes = await workerService.dispatchFiscalExtraCredit({
              operation: "creditFiscalExtraPack",
              companyId: packOrder.companyId,
              coreOrderId: packOrder.id,
              documentModel: packOrder.documentModel as "NFCE" | "NFE" | "MDFE",
              eventsGranted: packOrder.eventsGranted,
            });
            if (!creditRes.ok) {
              request.log.error(
                `[EFI Webhook] Falha ao enfileirar crédito fiscal extra: ${creditRes.error}`,
              );
              return reply.code(500).send({
                ok: false,
                message: "Falha ao enfileirar crédito do pacote",
              });
            }
          }

          await prisma.efiWebhookProcessed.create({
            data: {
              notificationToken,
              invoiceId: extraInvoice.id,
            },
          });
          request.log.info(
            `[EFI Webhook] Pacote extra pago e crédito enfileirado: ${packOrder.id}`,
          );
          return reply.send({ ok: true });
        }

        request.log.info(
          `[EFI Webhook] 🔎 Status elegível. Buscando fatura no banco local...`
        );
        // 3. Buscar os registros locais relacionados
        const invoiceOr: Array<Record<string, unknown>> = [];
        if (invoiceIdFromMetadata && typeof invoiceIdFromMetadata === "string") {
          invoiceOr.push({ id: invoiceIdFromMetadata });
        }
        if (subscription_id != null && String(subscription_id) !== "undefined") {
          invoiceOr.push({ externalId: String(subscription_id) });
          invoiceOr.push({
            payments: { some: { gatewayRef: String(subscription_id) } },
          });
        }
        if (charge_id != null && Number.isFinite(charge_id)) {
          invoiceOr.push({ externalId: String(charge_id) });
          invoiceOr.push({
            payments: { some: { efiChargeId: String(charge_id) } },
          });
        }

        if (invoiceOr.length === 0) {
          request.log.warn(
            "[EFI Webhook] Nenhum identificador (custom_id, subscription_id, charge_id) para localizar fatura.",
          );
          return reply.send({
            ok: true,
            message: "Notificação sem referência local",
          });
        }

        const invoice = await prisma.invoice.findFirst({
          where: { OR: invoiceOr as any },
        });

        if (!invoice) {
          request.log.warn(
            `[EFI Webhook] Cobrança/Assinatura ${subscription_id} (Ref: ${invoiceIdFromMetadata}) não encontrada no banco local.`
          );
          return reply.send({
            ok: true,
            message: "Notificação ignorada (não encontrada localmente)",
          });
        }

        if (invoice.invoiceKind === "FISCAL_EXTRA_PACK") {
          request.log.warn(
            `[EFI Webhook] Fatura extra de pacote fiscal caiu no fluxo legado; ignorando.`,
          );
          return reply.send({ ok: true, message: "Use fluxo fpx" });
        }

        if (!invoice.subscriptionId) {
          request.log.error(
            `[EFI Webhook] Fatura ${invoice.id} sem assinatura e não é fpx`,
          );
          return reply.code(400).send({ ok: false, message: "Fatura inválida" });
        }

        const subscription = await prisma.subscription.findUnique({
          where: { id: invoice.subscriptionId },
          include: { plan: true },
        });

        if (!subscription) {
          request.log.error(
            `[EFI Webhook] ERRO DE INTEGRIDADE: Assinatura ${invoice.subscriptionId} não encontrada para a fatura ${invoice.id}`
          );
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
          request.log.error(
            `[EFI Webhook] ERRO DE INTEGRIDADE: Empresa ${subscription.companyId} não encontrada para a assinatura ${subscription.id}`
          );
          return reply.code(404).send({ ok: false, message: "Empresa não encontrada" });
        }

        const adminUser = company.users[0];
        if (!adminUser) {
          request.log.error(
            `[EFI Webhook] Usuário ADMIN não encontrado para a empresa ${company.id}`
          );
          return reply.code(500).send({ ok: false, message: "Admin não encontrado" });
        }

        // 4. Lógica de Ativação vs Provisionamento
        // Só ativamos a EMPRESA e o LOGIN se o pagamento foi confirmado
        const shouldActivateAccess = hasPaidEvent;

        // Provisionamos apenas se o pagamento foi confirmado E se a empresa ainda não tem banco (setup inicial)
        const shouldProvision = hasPaidEvent && !company.databaseName;

        request.log.info(
          `[EFI Webhook] 🧠 Decisão Lógica: HasPaid=${hasPaidEvent} | DatabaseName='${company.databaseName || 'null'}'`
        );
        request.log.info(
          `[EFI Webhook] 🎯 Ação Final: Ativar Acesso? ${shouldActivateAccess ? '✅ SIM' : '❌ NÃO'} | Provisionar Banco? ${shouldProvision ? '✅ SIM' : '❌ NÃO'}`
        );

        // 5. Atualizar banco de dados via Transação
        await prisma.$transaction(async (tx) => {
          // SE o pagamento foi confirmado
          if (shouldActivateAccess) {
            // Marcar fatura como paga
            await tx.invoice.update({
              where: { id: invoice.id },
              data: {
                status: "paid",
                paidAt: new Date(),
              },
            });

            // Atualizar status do pagamento
            await tx.payment.updateMany({
              where: { invoiceId: invoice.id },
              data: {
                status: "captured",
                updatedAt: new Date(),
              },
            });

            // Ativar empresa e usuário para permitir login
            await tx.company.update({
              where: { id: company.id },
              data: { active: true },
            });

            await tx.user.update({
              where: { id: adminUser.id },
              data: { active: true },
            });

            // Ativar assinatura
            await tx.subscription.update({
              where: { id: subscription.id },
              data: {
                status: "active",
                ...(subscription.status !== "active"
                  ? {
                      nextDueDate: new Date(
                        Date.now() + 30 * 24 * 60 * 60 * 1000
                      ),
                    }
                  : {}),
              },
            });

            request.log.info(
              `[EFI Webhook] 🔓 ACESSO LIBERADO: Empresa ${company.name} e Assinatura ${subscription.id} ATIVADOS.`
            );
          }
        });

        // 6. Despachar para o Worker (Provisionamento de Banco)
        // Fazemos fora da transação para não travar o banco se o RabbitMQ demorar
        if (shouldProvision) {
          try {
            request.log.info(
              `[EFI Webhook] 🚀 Iniciando PROVISIONAMENTO para ${company.name}...`
            );
            const workerRes = await workerService.provisionDatabase(company.id);
            if (workerRes.ok) {
              request.log.info(`[EFI Webhook] ✅ Provisionamento enfileirado no Worker com sucesso.`);
            } else {
              request.log.error(
                `[EFI Webhook] ❌ Erro ao enfileirar no Worker: ${workerRes.error}`
              );
            }
          } catch (err) {
            request.log.error(`[EFI Webhook] 💥 EXCEÇÃO ao chamar Worker: ${err}`);
          }
        }

        // 7. Emissão automática de NFSe após pagamento (prestador = empresa emitente Tech Pozz no core)
        const nfseEmitenteCnpj = (process.env.NFSE_EMITENTE_CNPJ || "63132343000120")
          .replace(/\D/g, "")
          .padStart(14, "0")
          .slice(-14);
        const nfseEmitenteCompany = nfseEmitenteCnpj
          ? await prisma.company.findFirst({
              where: { cnpj: nfseEmitenteCnpj, databaseName: { not: null } },
            })
          : null;
        const nfseCompanyId = nfseEmitenteCompany?.id || company.id;
        if (
          hasPaidEvent &&
          !invoice.nfseEnqueuedAt &&
          nfseCompanyId &&
          (nfseEmitenteCompany ? true : !!company.databaseName)
        ) {
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
            } else {
              request.log.error(`[EFI Webhook] Erro ao enfileirar NFSe: ${nfseRes.error}`);
            }
          } catch (err) {
            request.log.error(`[EFI Webhook] EXCEÇÃO ao enfileirar NFSe: ${err}`);
          }
        } else if (
          hasPaidEvent &&
          !invoice.nfseEnqueuedAt &&
          !nfseEmitenteCompany &&
          !company.databaseName
        ) {
          request.log.info(
            `[EFI Webhook] NFSe não enfileirada: tenant ainda não provisionado (company ${company.id}).`
          );
        }

        // 8. Marcar webhook como processado (idempotência) APENAS se tomamos alguma ação real
        // Se entrou aqui só porque estava 'active' mas ainda não 'paid', não devemos queimar o token
        if (shouldActivateAccess || shouldProvision) {
          await prisma.efiWebhookProcessed.create({
            data: {
              notificationToken,
              invoiceId: invoice.id,
            },
          });
          request.log.info(`[EFI Webhook] 🔒 Processamento concluído com ações. Token de notificação salvo para idempotência.`);
        } else {
          request.log.info(`[EFI Webhook] ⏳ Nenhuma ação tomada (aguardando pagamento). Token não salvo para permitir retentativas/atualizações.`);
        }

        return reply.send({ ok: true });
      }

      request.log.info(`[EFI Webhook] 🛑 Eventos ignorados (Status irrelevantes para ativação).`);
      return reply.send({ ok: true, message: "Status ignorado" });
    } catch (error: any) {
      request.log.error(`[EFI Webhook] 🚨 ERRO CRÍTICO: ${JSON.stringify(error, null, 2)}`);
      return reply.code(500).send({
        ok: false,
        message: "Erro interno no processamento do webhook",
      });
    }
  });
}
