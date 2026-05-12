/** Normaliza features do plano vindas do banco (Json com { list: string[] }) */
export function normalizePlanFeatures(features: unknown): string[] {
  if (typeof features === "object" && features !== null && "list" in features) {
    const obj = features as { list: unknown };
    return Array.isArray(obj.list) ? obj.list.filter((f): f is string => typeof f === "string") : [];
  }
  return [];
}

/** Mapeamento key → nome da gestão (para módulos com key) */
const KEY_TO_MANAGEMENT: Record<string, string> = {
  vendas_pdv: "Vendas",
  emissao_nfce: "NFC-e",
  emissao_nfe: "NF-e",
};

/**
 * Verifica se um módulo está incluso no plano com base nas features (gestões).
 * Aceita moduleName (nome da gestão) ou moduleKey (chave do módulo).
 */
export function isModuleIncludedInPlan(
  planFeatures: string[] | undefined,
  moduleKey: string | null,
  moduleName?: string,
): boolean {
  if (!planFeatures?.length) return false;
  if (moduleName && planFeatures.includes(moduleName)) return true;
  if (moduleKey) {
    const name = KEY_TO_MANAGEMENT[moduleKey];
    if (name && planFeatures.includes(name)) return true;
  }
  return false;
}
