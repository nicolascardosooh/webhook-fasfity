import { getEfiInstance, cleanDocument } from "../lib/efi.js";
const formatCustomer = (customer) => {
    const doc = cleanDocument(customer.cpf);
    if (doc.length === 14) {
        return {
            juridical_person: {
                corporate_name: customer.name,
                cnpj: doc,
            },
            email: customer.email,
            phone_number: cleanDocument(customer.phone_number),
        };
    }
    else {
        const customerPF = {
            name: customer.name,
            cpf: doc,
            email: customer.email,
            phone_number: cleanDocument(customer.phone_number),
        };
        if (customer.birth) {
            customerPF.birth = customer.birth;
        }
        return customerPF;
    }
};
export const efiService = {
    createPlan: async (plan) => {
        const efi = getEfiInstance();
        try {
            const params = {};
            const body = {
                name: plan.name,
                interval: plan.interval,
                repeats: plan.repeats,
            };
            const response = await efi.createPlan(params, body);
            return response;
        }
        catch (error) {
            console.error("=== ERRO EFI CREATE PLAN ===");
            console.error("Mensagem:", (error === null || error === void 0 ? void 0 : error.message) || error);
            if (error === null || error === void 0 ? void 0 : error.error_description) {
                console.error("Descrição:", error.error_description);
            }
            if (typeof error === "object") {
                console.error("Detalhes:", JSON.stringify(error, null, 2));
            }
            console.error("============================");
            throw error;
        }
    },
    createSubscription: async (input) => {
        const efi = getEfiInstance();
        try {
            const params = {
                id: input.plan_id,
            };
            const items = input.items.map((item) => ({
                name: item.name,
                value: item.value,
                amount: item.amount,
            }));
            const body = {
                items,
                metadata: input.metadata,
            };
            console.log("EFI createSubscription Payload:", JSON.stringify(body, null, 2));
            const response = await efi.createSubscription(params, body);
            return response;
        }
        catch (error) {
            console.error("Erro ao criar assinatura EFI:", error);
            throw error;
        }
    },
    paySubscriptionCreditCard: async (subscriptionId, payment) => {
        const efi = getEfiInstance();
        const params = {
            id: subscriptionId,
        };
        const customerData = formatCustomer(payment.customer);
        const body = {
            payment: {
                credit_card: {
                    customer: customerData,
                    billing_address: {
                        street: payment.billing_address.street,
                        number: payment.billing_address.number,
                        complement: payment.billing_address.complement,
                        neighborhood: payment.billing_address.neighborhood,
                        city: payment.billing_address.city,
                        state: payment.billing_address.state,
                        zipcode: cleanDocument(payment.billing_address.zipcode),
                    },
                    payment_token: payment.payment_token,
                },
            },
        };
        console.log("EFI paySubscriptionCreditCard Payload:", JSON.stringify(body, null, 2));
        try {
            const response = await efi.defineSubscriptionPayMethod(params, body);
            return response;
        }
        catch (error) {
            console.error("Erro ao pagar assinatura (Cartão) EFI:", error);
            throw error;
        }
    },
    paySubscriptionBankingBillet: async (subscriptionId, payment) => {
        const efi = getEfiInstance();
        const params = {
            id: subscriptionId,
        };
        const customerData = formatCustomer(payment.customer);
        const body = {
            payment: {
                banking_billet: {
                    customer: customerData,
                    expire_at: payment.expire_at,
                    message: payment.message,
                    discount: payment.discount,
                    conditional_discount: payment.conditional_discount,
                },
            },
        };
        try {
            const response = await efi.defineSubscriptionPayMethod(params, body);
            console.log("EFI Boleto Response (Full):", JSON.stringify(response, null, 2));
            return response;
        }
        catch (error) {
            console.error("Erro ao pagar assinatura (Boleto) EFI:", error);
            throw error;
        }
    },
    getSubscription: async (subscriptionId) => {
        const efi = getEfiInstance();
        const params = {
            id: subscriptionId,
        };
        try {
            const response = await efi.detailSubscription(params);
            return response;
        }
        catch (error) {
            console.error("Erro ao obter detalhes da assinatura EFI:", error);
            throw error;
        }
    },
    getNotification: async (token) => {
        const efi = getEfiInstance();
        const params = {
            token: token,
        };
        try {
            const response = await efi.getNotification(params);
            return response;
        }
        catch (error) {
            console.error("Erro ao obter notificação EFI:", error);
            throw error;
        }
    }
};
//# sourceMappingURL=efiService.js.map