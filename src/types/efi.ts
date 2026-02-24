export interface EfiConfig {
  clientId: string;
  clientSecret: string;
  certificate?: string; // Caminho para o certificado .p12 (obrigatório para Pix/Bolix)
  sandbox: boolean;
  partnerToken?: string;
}

export interface EfiCustomer {
  name: string;
  cpf: string;
  email: string;
  phone_number: string;
  birth?: string; // YYYY-MM-DD
  address?: {
    street: string;
    number: string;
    complement?: string;
    neighborhood: string;
    city: string;
    state: string;
    zipcode: string;
  };
}

export interface EfiPlan {
  name: string;
  interval: number; // 1 = mensal
  repeats: number | null; // null = até cancelar
}

export interface EfiPlanResponse {
  code: number;
  data: {
    plan_id: number;
    name: string;
    interval: number;
    repeats: number | null;
    created_at: string;
  };
}

export interface EfiSubscriptionItem {
  name: string;
  value: number; // Em centavos (ex: 1990 para R$ 19,90)
  amount: number;
}

export interface EfiSubscriptionInput {
  plan_id: number;
  customer: EfiCustomer;
  items: EfiSubscriptionItem[];
  metadata?: {
    custom_id?: string;
    notification_url?: string;
  };
}

export interface EfiHistoryItem {
  charge_id: number;
  status: string;
  created_at: string;
  [key: string]: unknown;
}

export interface EfiSubscriptionResponse {
  code: number;
  data: {
    subscription_id: number;
    status: string; // 'new', 'active', 'paid', 'canceled', etc.
    custom_id?: string;
    plan: {
      id: number;
      name: string;
    };
    customer: {
      email: string;
      phone_number: string;
      cpf: string;
    };
    created_at: string;
    payment_method?: string;
    history?: EfiHistoryItem[];
    [key: string]: unknown;
  };
}

// Pagamento de Assinatura (Cartão)
export interface EfiPaymentCreditCard {
  billing_address: {
    street: string;
    number: string;
    complement?: string;
    neighborhood: string;
    city: string;
    state: string;
    zipcode: string;
  };
  payment_token: string; // Token gerado no front-end
  customer: EfiCustomer;
}

// Pagamento de Assinatura (Boleto/Bolix)
export interface EfiPaymentBankingBillet {
  expire_at?: string; // Data de vencimento da primeira cobrança (YYYY-MM-DD)
  customer: EfiCustomer;
  message?: string; // Mensagem no boleto
  discount?: {
    type: "percentage" | "currency";
    value: number;
  };
  conditional_discount?: {
    type: "percentage" | "currency";
    value: number;
  };
}

// Resposta de Pagamento (Cartão/Boleto)
export interface EfiPaymentResponse {
  code: number;
  data: {
    charge?: {
      pdf?: { charge?: string };
      billet_link?: string;
      link?: string;
      barcode?: string;
      pix?: any;
    };
    pdf?: { charge?: string };
    billet_link?: string;
    link?: string;
    barcode?: string;
    pix?: any;
    subscription_id?: number;
    [key: string]: unknown;
  };
}

// Resposta de Notificação (Webhook)
export interface EfiNotificationResponse {
  data: Array<{
    subscription_id?: number;
    identifiers?: {
      subscription_id: number;
    };
    custom_id?: string;
    status: {
      current: string;
      previous?: string | null;
    };
    type?: string;
    created_at: string;
    [key: string]: unknown;
  }>;
}

// Tipo genérico para respostas de Server Actions
export type ActionResponse<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      error: string;
    };
