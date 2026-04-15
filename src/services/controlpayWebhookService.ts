import {
  ControlPayHttpClient,
  extractControlPayWebhookFields,
  extractIntencaoFromGetByIdResponse,
  isLikelyIntencaoFinalizadaSucesso,
  resolveBaseUrlFromEnv,
} from "@repo/paygo-control-pay";
import type { TenantPrismaClient } from "@repo/db";

function pickPagamentoExternoId(intencao: Record<string, unknown>): string | null {
  const direct =
    intencao.pagamentoExternoId ??
    intencao.PagamentoExternoId ??
    intencao.idPagamentoExterno;
  if (direct != null && String(direct).trim() !== "") return String(direct);

  const arr = (intencao.pagamentosExternos ??
    intencao.PagamentosExternos) as unknown;
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
        : pagamentoJson.nsu != null
          ? String(pagamentoJson.nsu)
          : pagamentoJson.NSU != null
            ? String(pagamentoJson.NSU)
            : null;
  const autorizacao =
    pagamentoJson.autorizacao != null
      ? String(pagamentoJson.autorizacao)
      : pagamentoJson.codigoAutorizacao != null
        ? String(pagamentoJson.codigoAutorizacao)
        : pagamentoJson.numeroAutorizacao != null
          ? String(pagamentoJson.numeroAutorizacao)
          : null;
  return { nsu, autorizacao };
}

function pickAdquirenteNome(
  pagamentoJson: Record<string, unknown>,
): string | null {
  const direct =
    pagamentoJson.adquirente ?? pagamentoJson.Adquirente;
  if (direct != null && String(direct).trim() !== "") {
    return String(direct).trim();
  }
  const resposta = pagamentoJson.respostaAdquirente;
  if (typeof resposta === "string") {
    const m = resposta.match(/PWINFO_AUTHSYST\s*=\s*([^\r\n]+)/i);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/** Último recurso: acha adquirente em qualquer aninhamento do snapshot serializado. */
function pickAdquirenteFromSnapshotBlob(
  snapshot: Record<string, unknown>,
): string | null {
  try {
    const s = JSON.stringify(snapshot);
    const quoted = s.match(/"adquirente"\s*:\s*"([^"\\]*)"/i);
    if (quoted?.[1]?.trim()) return quoted[1].trim();
    const m = s.match(/PWINFO_AUTHSYST\s*=\s*([^\r\n"\\]+)/i);
    if (m?.[1]?.trim()) return m[1].trim();
  } catch {
    /* ignore */
  }
  return null;
}

const LOG_PREFIX = "[controlpay-hydrate]";

function logHydrate(msg: string, extra?: Record<string, unknown>): void {
  if (extra && Object.keys(extra).length > 0) {
    console.info(LOG_PREFIX, msg, extra);
  } else {
    console.info(LOG_PREFIX, msg);
  }
}

/** Variações comuns de idTransacao (número vs string, zeros). */
function idTransacaoWhereVariants(intencaoId: string): string[] {
  const s = String(intencaoId).trim();
  const out = new Set<string>([s]);
  if (/^\d+$/.test(s)) {
    out.add(String(Number(s)));
  }
  return [...out];
}

/**
 * PagamentoExterno/GetById costuma vir como folha ou embrulhado em
 * `{ pagamentoExterno: { ... } }` (às vezes duas vezes). Os campos NSU,
 * autorização e adquirente ficam só no objeto folha.
 */
function leafPagamentoExternoRecord(
  root: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!root || typeof root !== "object" || Array.isArray(root)) return undefined;
  let cur: Record<string, unknown> = root;
  const data = cur.data;
  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    ("pagamentoExterno" in (data as object) ||
      "PagamentoExterno" in (data as object) ||
      "adquirente" in (data as object))
  ) {
    cur = data as Record<string, unknown>;
  }
  for (let d = 0; d < 5; d++) {
    const nested =
      (cur.pagamentoExterno as Record<string, unknown> | undefined) ??
      (cur.PagamentoExterno as Record<string, unknown> | undefined);
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) break;
    cur = nested;
  }
  return cur;
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
  const variants = idTransacaoWhereVariants(intencaoVendaId);
  const pag = await tenant.pagamentoVenda.findFirst({
    where: {
      idTransacao: { in: variants },
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
  const { tenant, eventId, coreCompanyId } = args;

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
    logHydrate("abort: sem controlpayIntegrationKey na ConfiguracaoTef", {
      eventId,
      coreCompanyId,
    });
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
    logHydrate("abort: evento sem intencaoVendaId", { eventId, coreCompanyId });
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
    logHydrate("início consulta API", {
      eventId,
      coreCompanyId,
      intencaoVendaId: intencaoId,
    });
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
        logHydrate("PagamentoExterno/GetById ok", {
          eventId,
          pagamentoExternoId,
        });
      } catch (e) {
        snapshot.pagamentoExternoErro =
          e instanceof Error ? e.message : "erro PagamentoExterno";
        logHydrate("PagamentoExterno/GetById falhou", {
          eventId,
          pagamentoExternoId,
          erro: snapshot.pagamentoExternoErro,
        });
      }
    } else {
      logHydrate("sem pagamentoExternoId na intenção (só intencao/GetById)", {
        eventId,
        intencaoVendaId: intencaoId,
      });
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
    const pePayload = leafPagamentoExternoRecord(pgExt);

    const intencaoFlat =
      intencao && typeof intencao === "object"
        ? (intencao as Record<string, unknown>)
        : null;

    /** Mescla intenção + PagamentoExterno (folha): NSU, autorização, adquirente, bandeira. */
    const mergedForNfce: Record<string, unknown> = {
      ...(intencaoFlat ?? {}),
      ...(pePayload ?? {}),
    };

    let adquirenteNome = pickAdquirenteNome(mergedForNfce);
    if (!adquirenteNome) {
      adquirenteNome = pickAdquirenteFromSnapshotBlob(snapshot);
    }

    logHydrate("após merge snapshot", {
      eventId,
      vendaId,
      intencaoVendaId: intencaoId,
      statusId,
      statusNome,
      finalOk,
      pagamentoExternoId,
      temPeLeaf: !!pePayload,
      chavesPeLeaf: pePayload ? Object.keys(pePayload).slice(0, 25) : [],
      adquirenteExtraida: adquirenteNome ?? null,
    });

    /**
     * Grava PagamentoVenda sempre que houver vínculo com a venda — não exige mais
     * `finalOk`, porque o webhook pode chegar antes do GetById marcar "Creditado",
     * e o snapshot já traz adquirente/NSU no PagamentoExterno.
     */
    if (vendaId && intencaoId) {
      const idVariants = idTransacaoWhereVariants(intencaoId);
      const tefRows = await tenant.pagamentoVenda.findMany({
        where: {
          vendaId,
          formaPagamento: "TEF",
          idTransacao: { in: idVariants },
        },
      });

      if (tefRows.length === 0) {
        logHydrate("Nenhum PagamentoVenda TEF encontrado para intenção (idTransacao)", {
          eventId,
          vendaId,
          intencaoVendaId: intencaoId,
          idVariants,
        });
      }

      const { nsu, autorizacao } = pickAutorizacaoNsu(mergedForNfce);
      const bandeira = pickBandeira(mergedForNfce);
      const nfceTPag = pickNfceTPag(mergedForNfce);
      const nfceObsToken = `NFCE_TPag=${nfceTPag}`;
      for (const row of tefRows) {
        const obsBase = (row.observacoes ?? "").trim();
        const obs =
          obsBase.includes("NFCE_TPag=")
            ? obsBase
            : obsBase
              ? `${obsBase} | ${nfceObsToken}`
              : nfceObsToken;
        const adquirenteGravar =
          adquirenteNome != null && String(adquirenteNome).trim() !== ""
            ? String(adquirenteNome).trim()
            : row.adquirente ?? undefined;

        await tenant.pagamentoVenda.update({
          where: { id: row.id },
          data: {
            nsu: nsu ?? row.nsu ?? undefined,
            autorizacao: autorizacao ?? row.autorizacao ?? undefined,
            bandeira: bandeira ?? row.bandeira ?? undefined,
            ...(adquirenteGravar != null && adquirenteGravar !== ""
              ? { adquirente: adquirenteGravar }
              : {}),
            pagamentoExternoId: pagamentoExternoId ?? row.pagamentoExternoId ?? undefined,
            controlPayTokenNotificacao: ev.tokenNotificacao ?? undefined,
            observacoes: obs,
          },
        });

        logHydrate("PagamentoVenda atualizado", {
          eventId,
          pagamentoVendaId: row.id,
          nsu: nsu ?? row.nsu ?? null,
          temAutorizacao: !!(autorizacao ?? row.autorizacao),
          bandeira: bandeira ?? row.bandeira ?? null,
          adquirente: adquirenteGravar ?? null,
          finalOk,
        });
      }
    } else {
      logHydrate("skip gravar PagamentoVenda: falta vendaId ou intencaoId", {
        eventId,
        vendaId,
        intencaoVendaId: intencaoId,
      });
    }
  } catch (e) {
    logHydrate("erro na consulta/hidratação", {
      eventId,
      coreCompanyId,
      erro: e instanceof Error ? e.message : String(e),
    });
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
    const idVars = idTransacaoWhereVariants(extracted.intencaoVendaId);
    const pag = await args.tenant.pagamentoVenda.findFirst({
      where: {
        vendaId,
        idTransacao: { in: idVars },
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
