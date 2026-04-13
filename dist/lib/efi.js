import EfiPay from "sdk-node-apis-efi";
import path from "path";
const options = {
    sandbox: process.env.EFI_ENV !== "production",
    client_id: process.env.EFI_CLIENT_ID || "",
    client_secret: process.env.EFI_CLIENT_SECRET || "",
    certificate: process.env.EFI_CERTIFICATE_PATH
        ? path.resolve(process.cwd(), process.env.EFI_CERTIFICATE_PATH)
        : path.resolve(process.cwd(), "certs/productionCertificate.p12"),
    pem: process.env.EFI_PEM_BOOLEAN === "true",
};
console.log("[EFI] Inicializando com opções:", {
    sandbox: options.sandbox,
    client_id: options.client_id ? "***" + options.client_id.slice(-4) : "vazio",
    certificate: options.certificate,
    pem: options.pem,
});
let efiInstance = null;
export const getEfiInstance = () => {
    if (!efiInstance) {
        if (!options.client_id || !options.client_secret) {
            console.warn("EFI credentials not found in environment variables.");
        }
        efiInstance = new EfiPay(options);
    }
    return efiInstance;
};
export const toCents = (amount) => {
    return Math.round(amount * 100);
};
export const cleanDocument = (doc) => {
    return doc.replace(/\D/g, "");
};
//# sourceMappingURL=efi.js.map