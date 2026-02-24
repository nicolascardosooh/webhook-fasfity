"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanDocument = exports.toCents = exports.getEfiInstance = void 0;
const sdk_node_apis_efi_1 = __importDefault(require("sdk-node-apis-efi"));
const path_1 = __importDefault(require("path"));
const options = {
    sandbox: process.env.EFI_ENV !== "production",
    client_id: process.env.EFI_CLIENT_ID || "",
    client_secret: process.env.EFI_CLIENT_SECRET || "",
    certificate: process.env.EFI_CERTIFICATE_PATH
        ? path_1.default.resolve(process.cwd(), process.env.EFI_CERTIFICATE_PATH)
        : path_1.default.resolve(process.cwd(), "certs/productionCertificate.p12"),
    pem: process.env.EFI_PEM_BOOLEAN === "true",
};
console.log("[EFI] Inicializando com opções:", {
    sandbox: options.sandbox,
    client_id: options.client_id ? "***" + options.client_id.slice(-4) : "vazio",
    certificate: options.certificate,
    pem: options.pem,
});
let efiInstance = null;
const getEfiInstance = () => {
    if (!efiInstance) {
        if (!options.client_id || !options.client_secret) {
            console.warn("EFI credentials not found in environment variables.");
        }
        efiInstance = new sdk_node_apis_efi_1.default(options);
    }
    return efiInstance;
};
exports.getEfiInstance = getEfiInstance;
const toCents = (amount) => {
    return Math.round(amount * 100);
};
exports.toCents = toCents;
const cleanDocument = (doc) => {
    return doc.replace(/\D/g, "");
};
exports.cleanDocument = cleanDocument;
//# sourceMappingURL=efi.js.map