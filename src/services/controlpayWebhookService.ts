import {
  ControlPayHttpClient,
  extractControlPayWebhookFields,
  extractIntencaoFromGetByIdResponse,
  isLikelyIntencaoFinalizadaSucesso,
  resolveBaseUrlFromEnv,
} from "@repo/paygo-control-pay";
import type { TenantPrismaClient } from "@repo/db";

function pickPagamentoExternoId(intencao: Record<string, unknown>): string | null {
  const arr = intencao.pagamentosExternos;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const first = arr[0] as Record<string, unknown>;
  if (first?.id != null) return String(first.id);
  return null;
}

function pickAutorizacaoNsu(
  pagamentoJson: Record<string, unknown>,
): { nsu: string | null; autorizacao: string | null } {
  const nsu =
    pagamentoJson.nsuTid != null
      ? String(pagamentoJson.nsuTid)
      : pagamentoJson.trnNsu != null
        ? String(pagamentoJson.trnNsu)
        : null;
  const autorizacao =
    pagamentoJson.autorizacao != null
      ? String(pagamentoJson.autorizacao)
      : null;
  return { nsu, autorizacao };
}

function pickBandeira(
  pagamentoJson: Record<string, unknown>,
): string | null {
  const keys = [
    "bandeira",
    "nomeBandeira",
    "Bandeira",
    "nomeRedeBandeira",
    "nome_rede_bandeira",
  ];
  for (const k of keys) {
    const v = pagamentoJson[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

/** 03 = crédito, 04 = débito — heurística a partir do payload ControlPay. */
function pickNfceTPag(
  pagamentoJson: Record<string, unknown>,
): "03" | "04" {
  const parcelasRaw =
    pagamentoJson.quantidadeParcelas ??
    pagamentoJson.numParcelas ??
    pagamentoJson.parcelas ??
    pagamentoJson.quantidade_parcelas;
  const parcelas =
    parcelasRaw != null && !Number.isNaN(Number(parcelasRaw))
      ? Number(parcelasRaw)
      : 1;
  if (parcelas > 1) return "03";

  const blob = JSON.stringify(pagamentoJson).toLowerCase();
  if (blob.includes("credit") || blob.includes("crédito")) return "03";
  if (blob.includes("debit") || blob.includes("débit")) return "04";
  return "04";
}

async function findVendaFromTefIntencao(
  tenant: TenantPrismaClient,
  intencaoVendaId: string,
): Promise<{ vendaId: string; pagamentoVendaId: string } | null> {
  const pag = await tenant.pagamentoVenda.findFirst({
    where: {
      idTransacao: intencaoVendaId,
      formaPagamento: "TEF",
    },
    select: { id: true, vendaId: true },
  });
  if (!pag) return null;
  return { vendaId: pag.vendaId, pagamentoVendaId: pag.id };
}

export async function processControlPayHydration(args: {
  tenant: TenantPrismaClient;
  eventId: string;
  coreCompanyId: string;
}) {
  const { tenant, eventId } = args;

  const ev = await tenant.controlPayWebhookEvent.findUnique({
    where: { id: eventId },
  });
  if (!ev) return;

  const tefCfg = await tenant.configuracaoTef.findFirst({
    where: {
      NOT: { controlpayIntegrationKey: null },
      controlpayIntegrationKey: { not: "" },
    },
  });

  if (!tefCfg?.controlpayIntegrationKey) {
    await tenant.controlPayWebhookEvent.update({
      where: { id: eventId },
      data: {
        consultaErro: "Nenhuma ConfiguracaoTef com controlpayIntegrationKey",
        processadoEm: new Date(),
      },
    });
    return;
  }

  const ambiente =
    tefCfg.ambienteControlPay === "PRODUCAO" ? "PRODUCAO" : "SANDBOX";
  const baseUrl = resolveBaseUrlFromEnv(ambiente);
  const client = new ControlPayHttpClient({
    baseUrl,
    integrationKey: tefCfg.controlpayIntegrationKey,
  });

  const intencaoId = ev.intencaoVendaId;
  if (!intencaoId) {
    await tenant.controlPayWebhookEvent.update({
      where: { id: eventId },
      data: {
        consultaErro: "Sem intencaoVendaId para consultar",
        processadoEm: new Date(),
      },
    });
    return;
  }

  try {
    const raw = await client.intencaoVendaGetById(intencaoId);
    const { intencao, statusId, statusNome } =
      extractIntencaoFromGetByIdResponse(raw);

    let snapshot: Record<string, unknown> = { ...raw };
    let pagamentoExternoId = intencao
      ? pickPagamentoExternoId(intencao)
      : null;

    if (pagamentoExternoId) {
      try {
        const pe = await client.pagamentoExternoGetById(pagamentoExternoId);
        snapshot = { ...raw, pagamentoExterno: pe };
      } catch (e) {
        snapshot.pagamentoExternoErro =
          e instanceof Error ? e.message : "erro PagamentoExterno";
      }
    }

    let vendaId: string | null = ev.vendaId;
    if (!vendaId && intencao?.referencia != null) {
      const ref = String(intencao.referencia);
      const byId = await tenant.venda.findFirst({
        where: { id: ref },
        select: { id: true },
      });
      if (byId) vendaId = byId.id;
      if (!vendaId) {
        const byNum = await tenant.venda.findFirst({
          where: { numero: ref },
          select: { id: true },
        });
        if (byNum) vendaId = byNum.id;
      }
    }

    let pagamentoVendaId: string | null = ev.pagamentoVendaId;
    if (!vendaId || !pagamentoVendaId) {
      const fromPag = await findVendaFromTefIntencao(tenant, intencaoId);
      if (fromPag) {
        if (!vendaId) vendaId = fromPag.vendaId;
        if (!pagamentoVendaId) pagamentoVendaId = fromPag.pagamentoVendaId;
      }
    }

    await tenant.controlPayWebhookEvent.update({
      where: { id: eventId },
      data: {
        snapshotConsulta: snapshot as object,
        vendaId,
        pagamentoVendaId,
        processadoEm: new Date(),
        consultaErro: null,
      },
    });

    const finalOk = isLikelyIntencaoFinalizadaSucesso(statusId, statusNome);
    const pgExt = snapshot.pagamentoExterno as Record<string, unknown> | undefined;
    const pePayload =
      pgExt && typeof pgExt === "object"
        ? (pgExt.pagamentoExterno as Record<string, unknown> | undefined) ??
          pgExt
        : undefined;

    if (vendaId && intencaoId && finalOk && pePayload && typeof pePayload === "object") {
      const { nsu, autorizacao } = pickAutorizacaoNsu(pePayload);
      const bandeira = pickBandeira(pePayload);
      const nfceTPag = pickNfceTPag(pePayload);
      const tefRows = await tenant.pagamentoVenda.findMany({
        where: { vendaId, idTransacao: intencaoId, formaPagamento: "TEF" },
      });
      const nfceObsToken = `NFCE_TPag=${nfceTPag}`;
      for (const row of tefRows) {
        const obsBase = (row.observacoes ?? "").trim();
        const obs =
          obsBase.includes("NFCE_TPag=")
            ? obsBase
            : obsBase
              ? `${obsBase} | ${nfceObsToken}`
              : nfceObsToken;
        await tenant.pagamentoVenda.update({
          where: { id: row.id },
          data: {
            nsu: nsu ?? row.nsu ?? undefined,
            autorizacao: autorizacao ?? row.autorizacao ?? undefined,
            bandeira: bandeira ?? row.bandeira ?? undefined,
            pagamentoExternoId: pagamentoExternoId ?? row.pagamentoExternoId ?? undefined,
            controlPayTokenNotificacao: ev.tokenNotificacao ?? undefined,
            observacoes: obs,
          },
        });
      }
    }
  } catch (e) {
    await tenant.controlPayWebhookEvent.update({
      where: { id: eventId },
      data: {
        consultaErro: e instanceof Error ? e.message : "Erro consulta",
        processadoEm: new Date(),
      },
    });
  }
}

export async function createControlPayWebhookEventAndScheduleHydrate(args: {
  tenant: TenantPrismaClient;
  coreCompanyId: string;
  payload: unknown;
}): Promise<{ eventId: string; skippedDuplicate: boolean }> {
  const extracted = extractControlPayWebhookFields(args.payload);
  const payloadBruto =
    args.payload && typeof args.payload === "object"
      ? (args.payload as object)
      : { _raw: args.payload };

  const token =
    extracted.tokenNotificacao ||
    `noid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  if (extracted.tokenNotificacao) {
    const existing = await args.tenant.controlPayWebhookEvent.findFirst({
      where: { tokenNotificacao: extracted.tokenNotificacao },
    });
    if (existing) {
      return { eventId: existing.id, skippedDuplicate: true };
    }
  }

  let vendaId: string | null = null;
  let pagamentoVendaId: string | null = null;

  if (extracted.intencaoVendaId) {
    const fromPag = await findVendaFromTefIntencao(
      args.tenant,
      extracted.intencaoVendaId,
    );
    if (fromPag) {
      vendaId = fromPag.vendaId;
      pagamentoVendaId = fromPag.pagamentoVendaId;
    }
  }

  if (!vendaId && extracted.referencia) {
    const ref = extracted.referencia;
    const byId = await args.tenant.venda.findFirst({
      where: { id: ref },
      select: { id: true },
    });
    if (byId) vendaId = byId.id;
    if (!vendaId) {
      const byNum = await args.tenant.venda.findFirst({
        where: { numero: ref },
        select: { id: true },
      });
      if (byNum) vendaId = byNum.id;
    }
  }

  if (vendaId && extracted.intencaoVendaId && !pagamentoVendaId) {
    const pag = await args.tenant.pagamentoVenda.findFirst({
      where: {
        vendaId,
        idTransacao: extracted.intencaoVendaId,
        formaPagamento: "TEF",
      },
      select: { id: true },
    });
    if (pag) pagamentoVendaId = pag.id;
  }

  const created = await args.tenant.controlPayWebhookEvent.create({
    data: {
      vendaId,
      pagamentoVendaId,
      intencaoVendaId: extracted.intencaoVendaId,
      tokenNotificacao: token,
      tipoEvento: extracted.tipoEvento,
      payloadBruto,
    },
  });

  setImmediate(() => {
    processControlPayHydration({
      tenant: args.tenant,
      eventId: created.id,
      coreCompanyId: args.coreCompanyId,
    }).catch(console.error);
  });

  return { eventId: created.id, skippedDuplicate: false };
}
