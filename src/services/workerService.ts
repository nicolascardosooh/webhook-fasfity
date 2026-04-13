import amqp from "amqplib";
import { prisma } from "../lib/db.js";
import { qualifyRabbitName } from "../lib/rabbitmqTopology.js";

/** Payload enviado na fila para emissão automática de NFSe (pagamento). Dados vêm do banco (core + tenant). */
export interface NFSeEmitPayload {
  operation: "emitirAutoNFSe";
  companyId: string;
  invoiceId: string;
  /** true quando é primeiro provisionamento: um e-mail com boas-vindas + NFS-e (se autorizada). */
  includeWelcome?: boolean;
}

export interface WorkerProvisionInput {
  company_id: string; // ID da empresa no Core (para o Worker encontrar mesmo sem databaseName ainda)
  tenant_name: string; // slug (nome do banco/schema)
  admin_email: string;
  admin_password_hash: string;
  database_password?: string;
  plano_escolhido: string;
  modulos_contratados: string[];
}

export const workerService = {
  dispatchProvision: async (data: WorkerProvisionInput) => {
    const rabbitUrl = process.env.RABBITMQ_URL;

    if (!rabbitUrl) {
      console.warn(
        "RABBITMQ_URL não configurada no ambiente. Pulando despacho.",
      );
      return { ok: true, message: "RABBITMQ_URL não configurada (mock mode)" };
    }

    try {
      console.log(`[WorkerService] Conectando ao RabbitMQ em ${rabbitUrl}...`);
      const connection = await amqp.connect(rabbitUrl);
      const channel = await connection.createConfirmChannel();

      const exchange = qualifyRabbitName("infra.setup");
      const routingKey = qualifyRabbitName("create-tenant");

      await channel.assertExchange(exchange, "direct", { durable: true });

      console.log(
        `[WorkerService] Publicando provisionamento para ${data.tenant_name}...`,
      );

      const published = channel.publish(
        exchange,
        routingKey,
        Buffer.from(JSON.stringify(data)),
        { persistent: true },
      );

      if (!published) {
        throw new Error("Falha ao publicar mensagem no RabbitMQ (buffer cheio?)");
      }

      await channel.waitForConfirms();
      await channel.close();
      await connection.close();

      console.log(
        `[WorkerService] Mensagem enviada com sucesso para o RabbitMQ.`,
      );
      return { ok: true };
    } catch (error) {
      console.error("[WorkerService] Falha ao enviar para o RabbitMQ:", error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Erro desconhecido",
      };
    }
  },

  provisionDatabase: async (companyId: string) => {
    try {
      const company = await prisma.company.findUnique({
        where: { id: companyId },
        include: {
          users: { where: { role: "ADMIN" }, take: 1 },
          subscriptions: { include: { plan: true } },
        },
      });

      if (!company) throw new Error("Empresa não encontrada");

      const admin = company.users?.[0];
      if (!admin) throw new Error("Admin não encontrado");

      const subscription = company.subscriptions?.[0];
      const moduleKeys = subscription?.moduleKeys || [];

      console.log(
        `[WorkerService] Assinatura encontrada: ${subscription?.id || "Nenhuma"}`,
      );
      console.log(
        `[WorkerService] ModuleKeys encontrados:`,
        JSON.stringify(moduleKeys),
      );

      // 1. Nome do banco e senha para o payload (só o Worker grava no Core ao concluir)
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

      // 2. Resolver nomes/chaves dos módulos (Auto-correção para incluir gratuitos e plano avançado)
      const allActiveModules = await prisma.management.findMany({
        where: { active: true },
        select: { id: true, name: true, key: true, priceCents: true },
      });

      const planKey = subscription?.plan?.key;

      // Unificar: IDs salvos na assinatura + IDs de módulos gratuitos + IDs de módulos inclusos no plano
      const freeModuleIds = allActiveModules
        .filter((m) => m.priceCents === 0)
        .map((m) => m.id);

      const planInclusionIds: string[] = [];
      if (planKey === "avancado") {
        const matchingIds = allActiveModules
          .filter(
            (m) =>
              m.key === "vendas_pdv" ||
              m.key === "emissao_nfce" ||
              m.name.includes("Vendas") ||
              m.name.includes("NFC-e"),
          )
          .map((m) => m.id);
        planInclusionIds.push(...matchingIds);
      }

      const consolidatedIds = Array.from(
        new Set([...moduleKeys, ...freeModuleIds, ...planInclusionIds]),
      );

      const resolvedModules = allActiveModules
        .filter((m) => consolidatedIds.includes(m.id))
        .map((m) => m.key || m.name);

      console.log(
        `[WorkerService] IDs consolidados (${consolidatedIds.length}):`,
        JSON.stringify(consolidatedIds),
      );
      console.log(
        `[WorkerService] Módulos finais para o Worker:`,
        JSON.stringify(resolvedModules),
      );

      // 3. Montar payload
      const payload: WorkerProvisionInput = {
        company_id: companyId,
        tenant_name: tenantName as string,
        admin_email: admin.email,
        admin_password_hash: admin.password,
        database_password: tenantPass as string,
        plano_escolhido: subscription?.plan?.name || "plano_padrao",
        modulos_contratados: resolvedModules,
      };

      console.log(
        `[WorkerService] Payload enviado ao Worker:`,
        JSON.stringify(
          {
            ...payload,
            admin_password_hash: "***",
            database_password: "***",
          },
          null,
          2,
        ),
      );

      // 4. Despachar para o RabbitMQ (só o Worker grava databaseName/databasePass no Core ao concluir)
      const dispatchResult = await workerService.dispatchProvision(payload);
      return dispatchResult;
    } catch (error) {
      console.error("[WorkerService] Erro no provisionamento:", error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Erro desconhecido",
      };
    }
  },

  /** Envia job de emissão de NFSe para a fila. O Worker monta o payload a partir do banco (core + tenant). */
  dispatchNFSe: async (payload: NFSeEmitPayload) => {
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
      const published = channel.publish(
        exchange,
        routingKey,
        Buffer.from(JSON.stringify(payload)),
        { persistent: true }
      );
      await channel.close();
      await connection.close();
      if (!published) throw new Error("Falha ao publicar mensagem NFSe no RabbitMQ");
      console.log("[WorkerService] NFSe publicada na fila com sucesso.");
      return { ok: true };
    } catch (error) {
      console.error("[WorkerService] Falha ao enviar NFSe para o RabbitMQ:", error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Erro desconhecido",
      };
    }
  },
};
