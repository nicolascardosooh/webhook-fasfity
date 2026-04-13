/**
 * Saída colorida no terminal para cada POST ControlPay (fácil de achar no meio dos logs).
 * Não usar em rotas de alta frequência além deste webhook.
 */

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
};

const WIDTH = 72;

const lineHeavy = () => console.log(c.cyan + "═".repeat(WIDTH) + c.reset);
const lineThin = () => console.log(c.dim + "─".repeat(WIDTH) + c.reset);

export type ControlPayBannerStart = {
  phase: "start";
  coreCompanyId: string;
  databaseName?: string | null;
  intencaoVendaId?: string;
  referencia?: string;
  remoteIp?: string;
};

export type ControlPayBannerOk = {
  phase: "ok";
  eventId: string;
  skippedDuplicate: boolean;
  ms: number;
};

export type ControlPayBannerErr = {
  phase: "err";
  httpStatus: number;
  code?: string;
  message: string;
  hint?: string;
  ms: number;
};

export function printControlPayWebhookBanner(
  input: ControlPayBannerStart | ControlPayBannerOk | ControlPayBannerErr,
): void {
  if (input.phase === "start") {
    console.log("\n");
    lineHeavy();
    console.log(
      `${c.bold}${c.magenta}  ▶ ControlPay Webhook${c.reset}  ${c.dim}${new Date().toLocaleString("pt-BR", { hour12: false })}${c.reset}`,
    );
    lineThin();
    console.log(`  ${c.bold}companyId${c.reset}     ${input.coreCompanyId}`);
    if (input.databaseName) {
      console.log(`  ${c.bold}tenant DB${c.reset}     ${input.databaseName}`);
    }
    if (input.intencaoVendaId) {
      console.log(`  ${c.bold}intenção${c.reset}      ${input.intencaoVendaId}`);
    }
    if (input.referencia) {
      console.log(`  ${c.bold}referência${c.reset}    ${input.referencia}`);
    }
    if (input.remoteIp) {
      console.log(`  ${c.dim}origem IP${c.reset}      ${input.remoteIp}`);
    }
    lineThin();
    return;
  }

  if (input.phase === "ok") {
    const dup =
      input.skippedDuplicate ? ` ${c.yellow}(já existia — ignorado)${c.reset}` : "";
    console.log(
      `  ${c.green}${c.bold}✓ processado${c.reset}  eventId=${c.green}${input.eventId}${c.reset}${dup}  ${c.dim}${input.ms}ms${c.reset}`,
    );
    lineHeavy();
    console.log("");
    return;
  }

  console.log(`  ${c.red}${c.bold}✗ falhou${c.reset}     HTTP ${input.httpStatus}  ${c.dim}${input.ms}ms${c.reset}`);
  if (input.code) {
    console.log(`  ${c.bold}código${c.reset}        ${c.yellow}${input.code}${c.reset}`);
  }
  console.log(`  ${c.red}${input.message}${c.reset}`);
  if (input.hint) {
    console.log(`  ${c.dim}${input.hint}${c.reset}`);
  }
  lineHeavy();
  console.log("");
}
