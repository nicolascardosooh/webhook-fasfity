import EfiPay from "sdk-node-apis-efi";
import path from "path";
import {
  EfiPlanResponse,
  EfiSubscriptionResponse,
  EfiPaymentResponse,
  EfiNotificationResponse,
} from "../types/efi.js";

// Configurações padrão
const options = {
  sandbox: process.env.EFI_ENV !== "production",
  client_id: process.env.EFI_CLIENT_ID || "",
  client_secret: process.env.EFI_CLIENT_SECRET || "",
  certificate: process.env.EFI_CERTIFICATE_PATH
    ? path.resolve(process.cwd(), process.env.EFI_CERTIFICATE_PATH)
    : path.resolve(process.cwd(), "certs/productionCertificate.p12"),
  pem: process.env.EFI_PEM_BOOLEAN === "true", // Se estiver usando certificado PEM
};

console.log("[EFI] Inicializando com opções:", {
  sandbox: options.sandbox,
  client_id: options.client_id ? "***" + options.client_id.slice(-4) : "vazio",
  certificate: options.certificate,
  pem: options.pem,
});

// Interface para a instância do SDK EFI
export interface EfiInstance {
  createPlan: (params: unknown, body: unknown) => Promise<EfiPlanResponse>;
  createSubscription: (
    params: unknown,
    body: unknown,
  ) => Promise<EfiSubscriptionResponse>;
  defineSubscriptionPayMethod: (
    params: unknown,
    body: unknown,
  ) => Promise<EfiPaymentResponse>;
  detailSubscription: (params: unknown) => Promise<EfiSubscriptionResponse>;
  cancelSubscription: (params: unknown) => Promise<unknown>;
  getNotification: (params: {
    token: string;
  }) => Promise<EfiNotificationResponse>;
}

// Singleton para reutilizar a instância
let efiInstance: EfiInstance | null = null;

export const getEfiInstance = (): EfiInstance => {
  if (!efiInstance) {
    if (!options.client_id || !options.client_secret) {
      console.warn("EFI credentials not found in environment variables.");
    }
    // @ts-ignore
    efiInstance = new EfiPay(options) as unknown as EfiInstance;
  }
  return efiInstance;
};

// Helpers para formatar valores (EFI usa centavos, integer)
export const toCents = (amount: number): number => {
  return Math.round(amount * 100);
};

// Helper para formatar CPF/CNPJ (remover pontuação)
export const cleanDocument = (doc: string): string => {
  return doc.replace(/\D/g, "");
};
