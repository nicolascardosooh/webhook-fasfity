export function rabbitTopologySuffix() {
    const v = process.env.RABBITMQ_TOPOLOGY_VERSION;
    if (v !== undefined)
        return v.trim();
    return "v2";
}
export function qualifyRabbitName(name) {
    const s = rabbitTopologySuffix();
    return s ? `${name}.${s}` : name;
}
//# sourceMappingURL=rabbitmqTopology.js.map