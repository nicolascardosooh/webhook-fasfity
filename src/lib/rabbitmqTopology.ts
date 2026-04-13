/** Alinhado ao Worker: `RABBITMQ_TOPOLOGY_VERSION` + default `v2`. */
export function rabbitTopologySuffix(): string {
  const v = process.env.RABBITMQ_TOPOLOGY_VERSION;
  if (v !== undefined) return v.trim();
  return "v2";
}

export function qualifyRabbitName(name: string): string {
  const s = rabbitTopologySuffix();
  return s ? `${name}.${s}` : name;
}
