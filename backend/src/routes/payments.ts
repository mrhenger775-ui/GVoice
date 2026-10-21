import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { asyncHandler } from "../lib/async-handler.js";
import { getUsdRubRate } from "../lib/cbr-exchange.js";
import { prisma } from "../lib/prisma.js";
import {
  checkSteamLogin,
  getTopupBrands,
  getTopupOffers,
  isResellCodesConfigured,
  ResellCodesApiError,
  type ResellCodesTopupBrand,
  type ResellCodesTopupField
} from "../lib/resell-codes.js";
import { requireAuth } from "../middleware/auth.js";

const createOrderSchema = z.object({
  steamLogin: z.string().trim().min(2).max(64).regex(/^[^\s<>]+$/, "Некорректный Steam-логин"),
  steamAmount: z.coerce.number().finite().positive(),
  paymentMethod: z.enum(["card", "sbp"])
});

const createGameTopupOrderSchema = z.object({
  categoryId: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  offerId: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9_.-]+$/),
  fields: z.record(z.string().max(64), z.string().trim().min(1).max(256)),
  paymentMethod: z.enum(["card", "sbp"]).default("card")
});

const createSubscriptionOrderSchema = z.discriminatedUnion("paymentMethod", [
  z.object({
    paymentMethod: z.literal("card"),
    purchaseConsent: z.literal(true),
    recurringConsent: z.literal(true)
  }).strict(),
  z.object({
    paymentMethod: z.literal("sbp"),
    purchaseConsent: z.literal(true),
    recurringConsent: z.literal(false)
  }).strict()
]);

const GVOICE_PLUS_LEGAL_VERSION = "2026-10-20-recurring-v1";

const notificationSchema = z.object({
  TerminalKey: z.string().min(1),
  OrderId: z.string().uuid(),
  Success: z.union([z.boolean(), z.enum(["true", "false"])]),
  Status: z.string().min(1),
  PaymentId: z.union([z.string().min(1), z.number().finite()]),
  ErrorCode: z.union([z.string(), z.number()]),
  Amount: z.coerce.number().int().nonnegative(),
  RebillId: z.union([z.string().min(1), z.number().finite()]).optional(),
  CustomerKey: z.string().min(1).optional(),
  Token: z.string().min(1)
}).passthrough();

type TBankPayload = Record<string, unknown>;

type TBankCredentials = {
  terminalKey: string;
  password: string;
};

type TBankResponse = {
  Success?: boolean;
  ErrorCode?: string;
  Message?: string;
  Details?: string;
  PaymentId?: string | number;
  PaymentURL?: string;
  Status?: string;
  RebillId?: string | number;
  Data?: string;
};

const GVOICE_PLUS_PLAN = "gvoice_plus";
const GVOICE_PLUS_PERIOD_DAYS = 30;
const ALLOWED_GAME_TOPUP_BRANDS = new Set(["pubg mobile", "free fire", "mobile legends"]);
const SENSITIVE_GAME_FIELD_PATTERN = /(password|парол|email|e-mail|почт|login|логин|verification|otp|код подтверждения)/i;

function gvoicePlusPriceKopecks() {
  return env.GVOICE_PLUS_PRICE_RUB * 100;
}

function gameTopupsConfigured() {
  return env.GAME_TOPUPS_ENABLED === "true" && isTBankConfigured() && isResellCodesConfigured();
}

function isAllowedGameBrand(brand: string) {
  return ALLOWED_GAME_TOPUP_BRANDS.has(brand.trim().toLowerCase());
}

function fieldsAreSafe(fields: ResellCodesTopupField[]) {
  return fields.length > 0 && fields.length <= 5 && fields.every((field) =>
    Boolean(field.key && field.label)
    && !SENSITIVE_GAME_FIELD_PATTERN.test(`${field.key} ${field.label}`)
    && ["text", "number", "select"].includes(String(field.type || "text").toLowerCase())
  );
}

function categoryLooksSafe(category: { name: string; variant?: string; note?: string }) {
  return !SENSITIVE_GAME_FIELD_PATTERN.test(`${category.name} ${category.variant ?? ""} ${category.note ?? ""}`);
}

function calculateGameTopupPrice(priceUsd: number, usdRubRate: number) {
  const bufferedCostRub = priceUsd * usdRubRate * (1 + env.GAME_TOPUPS_FX_BUFFER_PERCENT / 100);
  const totalRub = bufferedCostRub * (1 + env.GAME_TOPUPS_MARKUP_PERCENT / 100);
  return Math.max(100, Math.ceil(totalRub * 100));
}

async function findAllowedGameCategory(categoryId: string) {
  const brands = await getTopupBrands();
  for (const brand of brands.data) {
    if (!isAllowedGameBrand(brand.brand)) continue;
    const category = brand.subcategories.find((item) => item.category_id === categoryId && categoryLooksSafe(item));
    if (category) return { brand, category };
  }
  return null;
}

class TBankApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TBankApiError";
  }
}

export const paymentsRouter = Router();

function isTBankConfigured() {
  return getTBankCredentials() !== null;
}

function getTBankCredentials(): TBankCredentials | null {
  if (!env.TBANK_TERMINAL_KEY || !env.TBANK_PASSWORD) return null;
  return { terminalKey: env.TBANK_TERMINAL_KEY, password: env.TBANK_PASSWORD };
}

function getTBankPlusCredentials(): TBankCredentials | null {
  if (!env.TBANK_PLUS_TERMINAL_KEY || !env.TBANK_PLUS_PASSWORD) return null;
  return { terminalKey: env.TBANK_PLUS_TERMINAL_KEY, password: env.TBANK_PLUS_PASSWORD };
}

function isTBankPlusConfigured() {
  return getTBankPlusCredentials() !== null;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left.toLowerCase(), "utf8");
  const rightBuffer = Buffer.from(right.toLowerCase(), "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function tokenValue(value: unknown) {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function createTBankToken(payload: TBankPayload, password: string) {
  return sha256(
    Object.entries({ ...payload, Password: password })
      .filter(([key, value]) => key !== "Token" && value !== undefined && value !== null && typeof value !== "object")
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, value]) => tokenValue(value))
      .join("")
  );
}

async function tbankRequest(method: "Init" | "GetQr" | "GetState" | "Cancel" | "Charge", payload: TBankPayload, credentials?: TBankCredentials) {
  const activeCredentials = credentials ?? getTBankCredentials();
  if (!activeCredentials) throw new Error("T-Bank terminal is not configured");
  const requestPayload: TBankPayload = {
    TerminalKey: activeCredentials.terminalKey,
    ...payload
  };
  requestPayload.Token = createTBankToken(requestPayload, activeCredentials.password);

  const response = await fetch(`${env.TBANK_API_URL.replace(/\/$/, "")}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestPayload),
    signal: AbortSignal.timeout(env.TBANK_REQUEST_TIMEOUT_MS)
  });
  const responseText = await response.text();
  let result: TBankResponse;
  try {
    result = JSON.parse(responseText) as TBankResponse;
  } catch {
    throw new TBankApiError(`Т-Банк вернул некорректный ответ (HTTP ${response.status})`);
  }
  if (!response.ok || result.Success !== true || String(result.ErrorCode ?? "") !== "0") {
    const detail = result.Details || result.Message || `HTTP ${response.status}`;
    throw new TBankApiError(`Т-Банк отклонил запрос: ${detail}`);
  }
  return result;
}

function formatKopecks(kopecks: number) {
  return (kopecks / 100).toFixed(2);
}

function tbankOperationId(paymentId: string) {
  return `tbank:${paymentId}`;
}

function rawTbankPaymentId(providerOperationId: string | null) {
  return providerOperationId?.startsWith("tbank:") ? providerOperationId.slice("tbank:".length) : null;
}

function subscriptionPaymentExpiryDate() {
  return new Date(Date.now() + env.TBANK_PENDING_EXPIRY_MINUTES * 60_000);
}

function tbankRedirectDueDate(expiresAt: Date) {
  return `${expiresAt.toISOString().slice(0, 19)}+00:00`;
}

function buildReceipt(
  customer: { email: string; phone: string | null },
  paymentAmountKopecks: number,
  itemName: string
) {
  if (env.TBANK_RECEIPT_ENABLED !== "true") return undefined;
  if (!env.TBANK_RECEIPT_TAXATION || !env.TBANK_RECEIPT_TAX) {
    throw new Error("Для чеков Т-Банка настройте TBANK_RECEIPT_TAXATION и TBANK_RECEIPT_TAX");
  }

  const contact = !customer.email.endsWith("@oauth.gvoice.invalid")
    ? { Email: customer.email }
    : customer.phone
      ? { Phone: customer.phone }
      : null;
  if (!contact) {
    throw new Error("Для электронного чека в профиле должна быть настоящая почта или телефон");
  }

  return {
    ...contact,
    Taxation: env.TBANK_RECEIPT_TAXATION,
    Items: [{
      Name: itemName,
      Price: paymentAmountKopecks,
      Quantity: 1,
      Amount: paymentAmountKopecks,
      Tax: env.TBANK_RECEIPT_TAX,
      PaymentMethod: "full_payment",
      PaymentObject: env.TBANK_RECEIPT_PAYMENT_OBJECT
    }]
  };
}

function serializeSubscriptionPayment(payment: {
  id: string;
  status: string;
  plan: string;
  billingPeriodDays: number;
  currency: string;
  paymentMethod: string;
  paymentAmountKopecks: number;
  paymentUrl: string | null;
  expiresAt: Date | null;
  paidAt: Date | null;
  appliedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: payment.id,
    status: payment.status,
    plan: payment.plan,
    billingPeriodDays: payment.billingPeriodDays,
    currency: payment.currency,
    paymentMethod: payment.paymentMethod,
    paymentAmount: formatKopecks(payment.paymentAmountKopecks),
    paymentUrl: payment.paymentUrl,
    expiresAt: payment.expiresAt?.toISOString() ?? null,
    paidAt: payment.paidAt?.toISOString() ?? null,
    appliedAt: payment.appliedAt?.toISOString() ?? null,
    createdAt: payment.createdAt.toISOString()
  };
}

function serializeSubscription(subscription: {
  plan: string;
  status: string;
  startedAt: Date;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  canceledAt: Date | null;
  autoRenew: boolean;
  nextChargeAt: Date | null;
} | null) {
  const active = Boolean(
    subscription
    && subscription.status === "active"
    && subscription.currentPeriodEnd.getTime() > Date.now()
  );
  return {
    plan: subscription?.plan ?? GVOICE_PLUS_PLAN,
    status: active ? "active" : subscription?.status ?? "inactive",
    active,
    startedAt: subscription?.startedAt.toISOString() ?? null,
    currentPeriodStart: subscription?.currentPeriodStart.toISOString() ?? null,
    currentPeriodEnd: subscription?.currentPeriodEnd.toISOString() ?? null,
    canceledAt: subscription?.canceledAt?.toISOString() ?? null,
    autoRenew: Boolean(active && subscription?.autoRenew && !subscription.canceledAt),
    nextChargeAt: subscription?.nextChargeAt?.toISOString() ?? null
  };
}

function serializeGameTopupOrder(order: {
  id: string;
  status: string;
  fulfillmentStatus: string;
  paymentMethod: string;
  currency: string;
  brand: string;
  categoryId: string;
  categoryName: string;
  offerId: string;
  offerName: string;
  region: string | null;
  variant: string | null;
  customerFieldsJson: string;
  paymentAmountKopecks: number;
  paidAt: Date | null;
  fulfilledAt: Date | null;
  supplierStatus: string | null;
  supplierStatusReason: string | null;
  supplierFailCode: string | null;
  createdAt: Date;
}) {
  let customerFields: Record<string, string> = {};
  try {
    customerFields = JSON.parse(order.customerFieldsJson) as Record<string, string>;
  } catch {
    customerFields = {};
  }
  return {
    id: order.id,
    status: order.status,
    fulfillmentStatus: order.fulfillmentStatus,
    paymentMethod: order.paymentMethod,
    currency: order.currency,
    brand: order.brand,
    categoryId: order.categoryId,
    categoryName: order.categoryName,
    offerId: order.offerId,
    offerName: order.offerName,
    region: order.region,
    variant: order.variant,
    customerFields,
    paymentAmount: formatKopecks(order.paymentAmountKopecks),
    paidAt: order.paidAt?.toISOString() ?? null,
    fulfilledAt: order.fulfilledAt?.toISOString() ?? null,
    supplierStatus: order.supplierStatus,
    supplierStatusReason: order.supplierStatusReason,
    supplierFailCode: order.supplierFailCode,
    createdAt: order.createdAt.toISOString()
  };
}

async function activateSubscriptionPayment(paymentId: string, providerOperationId: string, notificationRebillId?: string | null) {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.appliedAt) return;

    const now = new Date();
    const existing = await tx.gVoiceSubscription.findUnique({ where: { userId: payment.userId } });
    let periodStart = existing && existing.currentPeriodEnd.getTime() > now.getTime()
      ? existing.currentPeriodEnd
      : now;
    let periodEnd = new Date(periodStart);
    periodEnd.setUTCDate(periodEnd.getUTCDate() + payment.billingPeriodDays);

    // Prisma serializes DateTime only through year 9999. Lifetime/test subscriptions
    // already ending at that boundary cannot be extended without producing year 10000.
    // Keep their existing period while still marking the confirmed payment as applied.
    if (existing && (!Number.isFinite(periodEnd.getTime()) || periodEnd.getUTCFullYear() > 9999)) {
      periodStart = existing.currentPeriodStart;
      periodEnd = existing.currentPeriodEnd;
    }

    const rebillId = notificationRebillId || payment.providerRebillId || existing?.rebillId || null;
    const customerKey = `gvoice-plus-${payment.userId}`;
    const autoRenew = Boolean(payment.recurringConsentAt && rebillId);

    await tx.gVoiceSubscription.upsert({
      where: { userId: payment.userId },
      create: {
        userId: payment.userId,
        plan: payment.plan,
        status: "active",
        startedAt: now,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        autoRenew,
        recurringConsentAt: payment.recurringConsentAt,
        rebillId,
        customerKey: autoRenew ? customerKey : null,
        nextChargeAt: autoRenew ? periodEnd : null,
        renewalFailureCount: 0,
        lastRenewalError: null
      },
      update: {
        plan: payment.plan,
        status: "active",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        canceledAt: autoRenew ? null : existing?.canceledAt ?? null,
        autoRenew,
        recurringConsentAt: payment.recurringConsentAt ?? existing?.recurringConsentAt ?? null,
        rebillId: autoRenew ? rebillId : existing?.rebillId ?? null,
        customerKey: autoRenew ? customerKey : existing?.customerKey ?? null,
        nextChargeAt: autoRenew ? periodEnd : null,
        renewalFailureCount: 0,
        lastRenewalError: null
      }
    });

    await tx.subscriptionPayment.update({
      where: { id: payment.id },
      data: {
        status: "paid",
        providerOperationId,
        paidAt: payment.paidAt ?? now,
        appliedAt: now,
        providerRebillId: rebillId
      }
    });
  });
}

type ExpiringSubscriptionPayment = {
  id: string;
  status: string;
  providerOperationId: string | null;
};

async function expireSubscriptionPayment(payment: ExpiringSubscriptionPayment) {
  if (payment.status !== "pending" && payment.status !== "cancel_pending") return;
  const paymentId = rawTbankPaymentId(payment.providerOperationId);
  if (!paymentId) {
    await prisma.subscriptionPayment.updateMany({
      where: { id: payment.id, status: { in: ["pending", "cancel_pending"] } },
      data: { status: "deadline_expired" }
    });
    return;
  }

  const plusCredentials = getTBankPlusCredentials();
  if (!plusCredentials) return;

  try {
    const state = await tbankRequest("GetState", { PaymentId: paymentId }, plusCredentials);
    const status = String(state.Status ?? "").toUpperCase();
    if (["CONFIRMED", "AUTHORIZED"].includes(status)) {
      if (status === "CONFIRMED") {
        await activateSubscriptionPayment(payment.id, tbankOperationId(paymentId), state.RebillId == null ? null : String(state.RebillId));
      }
      return;
    }
    if (["CANCELED", "REJECTED", "AUTH_FAIL", "DEADLINE_EXPIRED", "REVERSED", "REFUNDED"].includes(status)) {
      await prisma.subscriptionPayment.updateMany({
        where: { id: payment.id, status: { in: ["pending", "cancel_pending"] } },
        data: { status: status === "CANCELED" ? "canceled" : "deadline_expired" }
      });
      return;
    }

    await prisma.subscriptionPayment.updateMany({
      where: { id: payment.id, status: "pending" },
      data: { status: "cancel_pending" }
    });
    await tbankRequest("Cancel", { PaymentId: paymentId }, plusCredentials);
    await prisma.subscriptionPayment.updateMany({
      where: { id: payment.id, status: { in: ["pending", "cancel_pending"] } },
      data: { status: "deadline_expired" }
    });
  } catch (error) {
    await prisma.subscriptionPayment.updateMany({
      where: { id: payment.id, status: "pending" },
      data: { status: "cancel_pending" }
    }).catch(() => undefined);
    console.error("GVoice+ stale payment cancellation failed", {
      paymentId: payment.id,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function expireStaleSubscriptionPayments(userId?: string) {
  const cutoff = new Date(Date.now() - env.TBANK_PENDING_EXPIRY_MINUTES * 60_000);
  const stalePayments = await prisma.subscriptionPayment.findMany({
    where: {
      ...(userId ? { userId } : {}),
      status: { in: ["pending", "cancel_pending"] },
      OR: [
        { expiresAt: { lte: new Date() } },
        { expiresAt: null, createdAt: { lte: cutoff } }
      ]
    },
    orderBy: { createdAt: "asc" },
    take: userId ? 30 : 20,
    select: { id: true, status: true, providerOperationId: true }
  });
  for (const payment of stalePayments) await expireSubscriptionPayment(payment);
}

let subscriptionRenewalTickRunning = false;

async function processDueSubscriptionRenewals() {
  if (env.GVOICE_PLUS_AUTORENEW_ENABLED !== "true") return;
  const plusCredentials = getTBankPlusCredentials();
  if (!plusCredentials) return;
  if (subscriptionRenewalTickRunning) return;
  subscriptionRenewalTickRunning = true;

  try {
    const now = new Date();
    const dueSubscriptions = await prisma.gVoiceSubscription.findMany({
      where: {
        status: "active",
        autoRenew: true,
        canceledAt: null,
        rebillId: { not: null },
        nextChargeAt: { lte: now }
      },
      orderBy: { nextChargeAt: "asc" },
      take: 20,
      include: { user: { select: { email: true, phone: true } } }
    });

    for (const subscription of dueSubscriptions) {
      if (!subscription.rebillId) continue;
      const retryAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const claimed = await prisma.gVoiceSubscription.updateMany({
        where: {
          id: subscription.id,
          autoRenew: true,
          canceledAt: null,
          nextChargeAt: subscription.nextChargeAt
        },
        data: {
          nextChargeAt: retryAt,
          lastRenewalAttemptAt: now,
          lastRenewalError: null
        }
      });
      if (claimed.count !== 1) continue;

      // A bank notification can be delayed or lost. Before creating another
      // debit, reconcile the most recent renewal with T-Bank so the same
      // subscription period cannot be charged twice.
      const previousRenewal = await prisma.subscriptionPayment.findFirst({
        where: {
          userId: subscription.userId,
          paymentKind: "renewal",
          appliedAt: null,
          providerOperationId: { not: null },
          status: { in: ["pending", "authorized", "payment_error"] }
        },
        orderBy: { createdAt: "desc" }
      });
      if (previousRenewal?.providerOperationId) {
        const previousPaymentId = rawTbankPaymentId(previousRenewal.providerOperationId);
        if (previousPaymentId) {
          try {
            const previousState = await tbankRequest("GetState", { PaymentId: previousPaymentId }, plusCredentials);
            const previousStatus = String(previousState.Status ?? "").toUpperCase();
            if (previousStatus === "CONFIRMED") {
              await activateSubscriptionPayment(previousRenewal.id, previousRenewal.providerOperationId, subscription.rebillId);
              continue;
            }
            if (["NEW", "FORM_SHOWED", "AUTHORIZING", "AUTHORIZED", "CONFIRMING"].includes(previousStatus)) {
              await prisma.subscriptionPayment.update({
                where: { id: previousRenewal.id },
                data: { status: previousStatus === "AUTHORIZED" ? "authorized" : "pending" }
              });
              continue;
            }
            if (["REJECTED", "CANCELED", "DEADLINE_EXPIRED", "REVERSED", "REFUNDED"].includes(previousStatus)) {
              await prisma.subscriptionPayment.update({
                where: { id: previousRenewal.id },
                data: { status: previousStatus.toLowerCase() }
              });
            } else {
              // Unknown bank state is not a safe reason to start a new debit.
              continue;
            }
          } catch (error) {
            await prisma.gVoiceSubscription.update({
              where: { id: subscription.id },
              data: {
                lastRenewalError: error instanceof Error ? error.message.slice(0, 500) : "Не удалось проверить предыдущий автоплатёж"
              }
            }).catch(() => undefined);
            continue;
          }
        }
      }

      const payment = await prisma.subscriptionPayment.create({
        data: {
          userId: subscription.userId,
          provider: "tbank",
          plan: GVOICE_PLUS_PLAN,
          billingPeriodDays: GVOICE_PLUS_PERIOD_DAYS,
          currency: "RUB",
          paymentAmountKopecks: gvoicePlusPriceKopecks(),
          recurringConsentAt: subscription.recurringConsentAt,
          paymentKind: "renewal",
          providerRebillId: subscription.rebillId,
          legalVersion: GVOICE_PLUS_LEGAL_VERSION
        }
      });

      try {
        const receipt = buildReceipt(subscription.user, gvoicePlusPriceKopecks(), "Продление GVoice+ на 30 дней");
        const initResult = await tbankRequest("Init", {
          Amount: gvoicePlusPriceKopecks(),
          OrderId: payment.id,
          Description: "GVoice+ — автоматическое продление на 30 дней",
          PayType: "O",
          Recurrent: "N",
          OperationInitiatorType: "R",
          Language: env.TBANK_LANGUAGE,
          NotificationURL: env.TBANK_PLUS_NOTIFICATION_URL,
          SuccessURL: env.TBANK_PLUS_SUCCESS_URL,
          FailURL: env.TBANK_PLUS_FAIL_URL,
          DATA: { connection_type: "Server", product: GVOICE_PLUS_PLAN, recurring: "true" },
          ...(receipt ? { Receipt: receipt } : {})
        }, plusCredentials);
        const paymentId = String(initResult.PaymentId ?? "").trim();
        if (!paymentId) throw new TBankApiError("Т-Банк не вернул идентификатор автоплатежа");

        await prisma.subscriptionPayment.update({
          where: { id: payment.id },
          data: { providerOperationId: tbankOperationId(paymentId) }
        });
        const chargeResult = await tbankRequest("Charge", {
          PaymentId: paymentId,
          RebillId: subscription.rebillId
        }, plusCredentials);
        if (chargeResult.Success !== true) {
          throw new TBankApiError(chargeResult.Details || chargeResult.Message || "Т-Банк отклонил автоплатёж");
        }
        if (String(chargeResult.Status ?? "").toUpperCase() === "CONFIRMED") {
          await activateSubscriptionPayment(payment.id, tbankOperationId(paymentId), subscription.rebillId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : "Не удалось выполнить автоплатёж";
        await prisma.subscriptionPayment.update({
          where: { id: payment.id },
          data: { status: "payment_error" }
        }).catch(() => undefined);
        await prisma.gVoiceSubscription.update({
          where: { id: subscription.id },
          data: {
            renewalFailureCount: { increment: 1 },
            lastRenewalError: message,
            nextChargeAt: retryAt
          }
        }).catch(() => undefined);
        console.error("GVoice+ automatic renewal failed", { subscriptionId: subscription.id, message });
      }
    }
  } finally {
    subscriptionRenewalTickRunning = false;
  }
}

export function startSubscriptionRenewalWorker() {
  void expireStaleSubscriptionPayments().catch((error) => console.error("GVoice+ payment expiry worker failed:", error));
  const expiryTimer = setInterval(() => {
    void expireStaleSubscriptionPayments().catch((error) => console.error("GVoice+ payment expiry worker failed:", error));
  }, 60_000);
  expiryTimer.unref();

  if (env.GVOICE_PLUS_AUTORENEW_ENABLED !== "true") {
    console.info("GVoice+ automatic renewal worker is disabled until acquiring approval");
    return;
  }
  console.info("GVoice+ automatic renewal worker started", {
    intervalMs: env.GVOICE_PLUS_RENEWAL_INTERVAL_MS
  });
  void processDueSubscriptionRenewals().catch((error) => console.error("GVoice+ renewal worker failed:", error));
  const timer = setInterval(() => {
    void processDueSubscriptionRenewals().catch((error) => console.error("GVoice+ renewal worker failed:", error));
  }, env.GVOICE_PLUS_RENEWAL_INTERVAL_MS);
  timer.unref();
}

function serializeOrder(order: {
  id: string;
  status: string;
  fulfillmentStatus: string;
  paymentMethod: string;
  currency: string;
  steamLogin: string;
  steamAmountKopecks: number;
  serviceFeeKopecks: number;
  paymentAmountKopecks: number;
  paidAt: Date | null;
  fulfilledAt: Date | null;
  supplierOrderNumber: number | null;
  supplierStatus: string | null;
  supplierStatusReason: string | null;
  supplierFailCode: string | null;
  createdAt: Date;
}) {
  return {
    id: order.id,
    status: order.status,
    fulfillmentStatus: order.fulfillmentStatus,
    paymentMethod: order.paymentMethod,
    currency: order.currency,
    steamLogin: order.steamLogin,
    steamAmount: formatKopecks(order.steamAmountKopecks),
    serviceFee: formatKopecks(order.serviceFeeKopecks),
    paymentAmount: formatKopecks(order.paymentAmountKopecks),
    paidAt: order.paidAt?.toISOString() ?? null,
    fulfilledAt: order.fulfilledAt?.toISOString() ?? null,
    supplierOrderNumber: order.supplierOrderNumber,
    supplierStatus: order.supplierStatus,
    supplierStatusReason: order.supplierStatusReason,
    supplierFailCode: order.supplierFailCode,
    createdAt: order.createdAt.toISOString()
  };
}

paymentsRouter.get("/config", requireAuth, (_req, res) => {
  res.json({
    enabled: env.STORE_PAYMENTS_ENABLED === "true",
    configured: env.STORE_PAYMENTS_ENABLED === "true" && isTBankConfigured() && isResellCodesConfigured(),
    paymentConfigured: isTBankConfigured(),
    fulfillmentConfigured: isResellCodesConfigured(),
    terminalKey: env.TBANK_TERMINAL_KEY ?? null,
    currency: "RUB",
    minSteamAmount: env.STEAM_TOPUP_MIN_RUB,
    maxSteamAmount: env.STEAM_TOPUP_MAX_RUB,
    markupPercent: env.STEAM_TOPUP_MARKUP_PERCENT,
    gvoicePlus: {
      enabled: env.GVOICE_PLUS_ENABLED === "true" && isTBankPlusConfigured(),
      terminalKey: env.TBANK_PLUS_TERMINAL_KEY ?? null,
      plan: GVOICE_PLUS_PLAN,
      name: "GVoice+",
      priceRub: env.GVOICE_PLUS_PRICE_RUB,
      billingPeriodDays: GVOICE_PLUS_PERIOD_DAYS,
      recurring: true
    },
    gameTopups: {
      enabled: gameTopupsConfigured(),
      markupPercent: env.GAME_TOPUPS_MARKUP_PERCENT,
      fxBufferPercent: env.GAME_TOPUPS_FX_BUFFER_PERCENT,
      brands: ["PUBG Mobile", "Free Fire", "Mobile Legends"]
    }
  });
});

paymentsRouter.get("/game-topups/brands", requireAuth, asyncHandler(async (_req, res) => {
  if (!isResellCodesConfigured()) {
    return void res.status(503).json({ error: "Каталог игровых пополнений ещё не настроен" });
  }
  const payload = await getTopupBrands();
  const brands = payload.data
    .filter((brand) => isAllowedGameBrand(brand.brand))
    .map((brand) => ({
      brand: brand.brand,
      subcategories: brand.subcategories.filter(categoryLooksSafe).map((category) => ({
        categoryId: category.category_id,
        name: category.name,
        region: category.region ?? "GLOBAL",
        variant: category.variant ?? null,
        image: category.image ?? null,
        note: category.note ?? null
      }))
    }))
    .filter((brand) => brand.subcategories.length > 0);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.json({ brands });
}));

paymentsRouter.get("/game-topups/categories/:categoryId/offers", requireAuth, asyncHandler(async (req, res) => {
  if (!isResellCodesConfigured()) {
    return void res.status(503).json({ error: "Каталог игровых пополнений ещё не настроен" });
  }
  const match = await findAllowedGameCategory(req.params.categoryId);
  if (!match) return void res.status(404).json({ error: "Игра или регион недоступны" });

  const payload = await getTopupOffers(req.params.categoryId);
  if (!fieldsAreSafe(payload.fields)) {
    return void res.status(409).json({ error: "Для этого варианта нужны данные входа. Он скрыт из соображений безопасности" });
  }
  const usdRubRate = await getUsdRubRate();
  const offers = payload.offers
    .map((offer) => {
      const priceUsd = Number(offer.price_usd);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
      return {
        offerId: offer.offer_id,
        name: offer.name,
        priceRub: formatKopecks(calculateGameTopupPrice(priceUsd, usdRubRate)),
        available: offer.stock == null || offer.stock > 0
      };
    })
    .filter((offer): offer is NonNullable<typeof offer> => offer !== null);

  res.setHeader("Cache-Control", "private, max-age=120");
  res.json({
    brand: match.brand.brand,
    category: {
      categoryId: match.category.category_id,
      name: payload.name || match.category.name,
      region: match.category.region ?? "GLOBAL",
      variant: match.category.variant ?? null,
      note: payload.note ?? match.category.note ?? null
    },
    fields: payload.fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type || "text",
      required: field.required !== false,
      placeholder: field.placeholder ?? null,
      options: field.options ?? []
    })),
    offers,
    pricing: {
      currency: "RUB",
      markupPercent: env.GAME_TOPUPS_MARKUP_PERCENT,
      fxBufferPercent: env.GAME_TOPUPS_FX_BUFFER_PERCENT
    }
  });
}));

paymentsRouter.get("/game-topups/orders", requireAuth, asyncHandler(async (req, res) => {
  const orders = await prisma.gameTopupOrder.findMany({
    where: { userId: req.auth!.userId },
    orderBy: { createdAt: "desc" },
    take: 30
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ orders: orders.map(serializeGameTopupOrder) });
}));

paymentsRouter.get("/game-topups/orders/:orderId", requireAuth, asyncHandler(async (req, res) => {
  const order = await prisma.gameTopupOrder.findFirst({
    where: { id: req.params.orderId, userId: req.auth!.userId }
  });
  if (!order) return void res.status(404).json({ error: "Заказ игрового пополнения не найден" });
  res.setHeader("Cache-Control", "no-store");
  res.json({ order: serializeGameTopupOrder(order) });
}));

paymentsRouter.post("/game-topups/orders", requireAuth, asyncHandler(async (req, res) => {
  if (!gameTopupsConfigured()) {
    return void res.status(503).json({ error: "Игровые пополнения пока закрыты для оплаты" });
  }
  const parsed = createGameTopupOrderSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Проверьте игру, пакет и данные аккаунта" });

  const match = await findAllowedGameCategory(parsed.data.categoryId);
  if (!match) return void res.status(404).json({ error: "Игра или регион недоступны" });
  const catalog = await getTopupOffers(parsed.data.categoryId);
  if (!fieldsAreSafe(catalog.fields)) {
    return void res.status(409).json({ error: "Этот вариант требует данные входа и недоступен в GVoice" });
  }
  const expectedKeys = catalog.fields.map((field) => field.key).sort();
  const receivedKeys = Object.keys(parsed.data.fields).sort();
  if (expectedKeys.length !== receivedKeys.length || expectedKeys.some((key, index) => key !== receivedKeys[index])) {
    return void res.status(400).json({ error: "Заполните все поля игрока, которые запросила выбранная игра" });
  }
  for (const field of catalog.fields) {
    const value = parsed.data.fields[field.key];
    if (!value || SENSITIVE_GAME_FIELD_PATTERN.test(`${field.key} ${field.label}`)) {
      return void res.status(400).json({ error: `Проверьте поле «${field.label}»` });
    }
    if (String(field.type).toLowerCase() === "select" && field.options?.length) {
      const allowedValues = field.options.map((option) => typeof option === "string" ? option : option.value);
      if (!allowedValues.includes(value)) return void res.status(400).json({ error: `Выберите допустимое значение «${field.label}»` });
    }
  }

  const offer = catalog.offers.find((item) => item.offer_id === parsed.data.offerId);
  const priceUsd = Number(offer?.price_usd);
  if (!offer || !Number.isFinite(priceUsd) || priceUsd <= 0 || (offer.stock != null && offer.stock <= 0)) {
    return void res.status(409).json({ error: "Выбранный пакет закончился или изменился. Обновите каталог" });
  }
  const usdRubRate = await getUsdRubRate();
  const paymentAmountKopecks = calculateGameTopupPrice(priceUsd, usdRubRate);

  const customer = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: { email: true, phone: true }
  });
  if (!customer) return void res.status(401).json({ error: "Пользователь не найден" });
  let receipt: ReturnType<typeof buildReceipt>;
  try {
    receipt = buildReceipt(customer, paymentAmountKopecks, `Игровое пополнение: ${offer.name}`.slice(0, 128));
  } catch (error) {
    return void res.status(503).json({ error: error instanceof Error ? error.message : "Не удалось подготовить электронный чек" });
  }

  const order = await prisma.gameTopupOrder.create({
    data: {
      userId: req.auth!.userId,
      paymentMethod: parsed.data.paymentMethod,
      brand: match.brand.brand,
      categoryId: match.category.category_id,
      categoryName: catalog.name || match.category.name,
      offerId: offer.offer_id,
      offerName: offer.name,
      region: match.category.region ?? "GLOBAL",
      variant: match.category.variant ?? null,
      customerFieldsJson: JSON.stringify(parsed.data.fields),
      supplierPriceUsdMicros: Math.round(priceUsd * 1_000_000),
      usdRubRateMicros: Math.round(usdRubRate * 1_000_000),
      fxBufferBasisPoints: Math.round(env.GAME_TOPUPS_FX_BUFFER_PERCENT * 100),
      markupBasisPoints: Math.round(env.GAME_TOPUPS_MARKUP_PERCENT * 100),
      paymentAmountKopecks
    }
  });

  try {
    const initResult = await tbankRequest("Init", {
      Amount: paymentAmountKopecks,
      OrderId: order.id,
      Description: `${match.brand.brand}: ${offer.name}`.slice(0, 140),
      PayType: "O",
      Language: env.TBANK_LANGUAGE,
      NotificationURL: env.TBANK_NOTIFICATION_URL,
      SuccessURL: env.TBANK_SUCCESS_URL,
      FailURL: env.TBANK_FAIL_URL,
      DATA: { connection_type: "Widget", product: "game_topup" },
      ...(receipt ? { Receipt: receipt } : {})
    });
    const paymentId = String(initResult.PaymentId ?? "").trim();
    let paymentUrl = String(initResult.PaymentURL ?? "").trim();
    if (!paymentId) throw new TBankApiError("Т-Банк не вернул идентификатор платежа");
    if (parsed.data.paymentMethod === "sbp") {
      const qrResult = await tbankRequest("GetQr", {
        PaymentId: paymentId,
        DataType: "PAYLOAD",
        PaymentMethod: "SBP"
      });
      paymentUrl = String(qrResult.Data ?? "").trim();
    }
    if (!/^https:\/\//i.test(paymentUrl)) throw new TBankApiError("Т-Банк не вернул ссылку для оплаты");
    const updatedOrder = await prisma.gameTopupOrder.update({
      where: { id: order.id },
      data: { providerOperationId: tbankOperationId(paymentId) }
    });
    res.status(201).json({ order: serializeGameTopupOrder(updatedOrder), paymentUrl });
  } catch (error) {
    await prisma.gameTopupOrder.update({ where: { id: order.id }, data: { status: "payment_error" } }).catch(() => undefined);
    res.status(502).json({ error: error instanceof Error ? error.message : "Не удалось связаться с Т-Банком" });
  }
}));

paymentsRouter.get("/subscriptions/me", requireAuth, asyncHandler(async (req, res) => {
  await expireStaleSubscriptionPayments(req.auth!.userId);
  const subscription = await prisma.gVoiceSubscription.findUnique({
    where: { userId: req.auth!.userId }
  });
  const pendingPayment = await prisma.subscriptionPayment.findFirst({
    where: {
      userId: req.auth!.userId,
      status: "pending",
      paymentUrl: { not: null },
      expiresAt: { gt: new Date() }
    },
    orderBy: { createdAt: "desc" }
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({
    subscription: serializeSubscription(subscription),
    pendingPayment: pendingPayment ? serializeSubscriptionPayment(pendingPayment) : null
  });
}));

paymentsRouter.post("/subscriptions/me/cancel-renewal", requireAuth, asyncHandler(async (req, res) => {
  const subscription = await prisma.gVoiceSubscription.findUnique({
    where: { userId: req.auth!.userId }
  });
  if (!subscription || subscription.status !== "active" || subscription.currentPeriodEnd.getTime() <= Date.now()) {
    return void res.status(404).json({ error: "Активная подписка GVoice+ не найдена" });
  }
  const updated = subscription.canceledAt && !subscription.autoRenew
    ? subscription
    : await prisma.gVoiceSubscription.update({
        where: { userId: req.auth!.userId },
        data: { canceledAt: new Date(), autoRenew: false, nextChargeAt: null }
      });
  res.setHeader("Cache-Control", "no-store");
  res.json({ subscription: serializeSubscription(updated) });
}));

paymentsRouter.get("/subscriptions/orders", requireAuth, asyncHandler(async (req, res) => {
  await expireStaleSubscriptionPayments(req.auth!.userId);
  const orders = await prisma.subscriptionPayment.findMany({
    where: {
      userId: req.auth!.userId,
      status: { notIn: ["deadline_expired", "canceled", "payment_error"] }
    },
    orderBy: { createdAt: "desc" },
    take: 30
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ orders: orders.map(serializeSubscriptionPayment) });
}));

paymentsRouter.get("/subscriptions/orders/:orderId", requireAuth, asyncHandler(async (req, res) => {
  await expireStaleSubscriptionPayments(req.auth!.userId);
  const order = await prisma.subscriptionPayment.findFirst({
    where: { id: req.params.orderId, userId: req.auth!.userId }
  });
  if (!order) return void res.status(404).json({ error: "Платёж подписки не найден" });
  res.setHeader("Cache-Control", "no-store");
  res.json({ order: serializeSubscriptionPayment(order) });
}));

paymentsRouter.post("/subscriptions/gvoice-plus/orders", requireAuth, asyncHandler(async (req, res) => {
  if (env.GVOICE_PLUS_ENABLED !== "true") {
    return void res.status(503).json({ error: "Оформление GVoice+ откроется после запуска функций тарифа" });
  }
  const plusCredentials = getTBankPlusCredentials();
  if (!plusCredentials) {
    return void res.status(503).json({ error: "Оплата GVoice+ временно недоступна" });
  }
  const consent = createSubscriptionOrderSchema.safeParse(req.body);
  if (!consent.success) {
    return void res.status(400).json({
      error: "Выберите способ оплаты и подтвердите условия GVoice+"
    });
  }
  const paymentMethod = consent.data.paymentMethod;

  await expireStaleSubscriptionPayments(req.auth!.userId);
  const reusableOrder = await prisma.subscriptionPayment.findFirst({
    where: {
      userId: req.auth!.userId,
      status: "pending",
      plan: GVOICE_PLUS_PLAN,
      paymentKind: "initial",
      paymentMethod,
      paymentAmountKopecks: gvoicePlusPriceKopecks(),
      paymentUrl: { not: null },
      expiresAt: { gt: new Date() }
    },
    orderBy: { createdAt: "desc" }
  });
  if (reusableOrder?.paymentUrl) {
    res.setHeader("Cache-Control", "no-store");
    return void res.json({
      order: serializeSubscriptionPayment(reusableOrder),
      paymentUrl: reusableOrder.paymentUrl,
      reused: true
    });
  }

  const customer = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: { email: true, phone: true }
  });
  if (!customer) return void res.status(401).json({ error: "Пользователь не найден" });

  let receipt: ReturnType<typeof buildReceipt>;
  try {
    receipt = buildReceipt(customer, gvoicePlusPriceKopecks(), "Подписка GVoice+ на 30 дней");
  } catch (error) {
    return void res.status(503).json({
      error: error instanceof Error ? error.message : "Не удалось подготовить электронный чек"
    });
  }

  const expiresAt = subscriptionPaymentExpiryDate();
  const order = await prisma.subscriptionPayment.create({
    data: {
      userId: req.auth!.userId,
      provider: "tbank",
      plan: GVOICE_PLUS_PLAN,
      billingPeriodDays: GVOICE_PLUS_PERIOD_DAYS,
      currency: "RUB",
      paymentMethod,
      paymentAmountKopecks: gvoicePlusPriceKopecks(),
      recurringConsentAt: paymentMethod === "card" ? new Date() : null,
      paymentKind: "initial",
      legalVersion: GVOICE_PLUS_LEGAL_VERSION,
      consentIp: req.ip?.slice(0, 128) || null,
      consentUserAgent: req.get("user-agent")?.slice(0, 512) || null,
      expiresAt
    }
  });

  try {
    const initResult = await tbankRequest("Init", {
      Amount: gvoicePlusPriceKopecks(),
      OrderId: order.id,
      Description: "GVoice+ — подписка на 30 дней",
      PayType: "O",
      ...(paymentMethod === "card" ? {
        Recurrent: "Y",
        CustomerKey: `gvoice-plus-${req.auth!.userId}`,
        OperationInitiatorType: "1"
      } : {}),
      Language: env.TBANK_LANGUAGE,
      NotificationURL: env.TBANK_PLUS_NOTIFICATION_URL,
      SuccessURL: env.TBANK_PLUS_SUCCESS_URL,
      FailURL: env.TBANK_PLUS_FAIL_URL,
      RedirectDueDate: tbankRedirectDueDate(expiresAt),
      DATA: {
        connection_type: "Widget",
        product: GVOICE_PLUS_PLAN,
        recurring: paymentMethod === "card" ? "true" : "false",
        payment_method: paymentMethod
      },
      ...(receipt ? { Receipt: receipt } : {})
    }, plusCredentials);
    const paymentId = String(initResult.PaymentId ?? "").trim();
    if (!paymentId) throw new TBankApiError("Т-Банк не вернул идентификатор платежа");
    let paymentUrl = String(initResult.PaymentURL ?? "").trim();
    if (paymentMethod === "sbp") {
      const qrResult = await tbankRequest("GetQr", {
        PaymentId: paymentId,
        DataType: "PAYLOAD",
        PaymentMethod: "SBP"
      }, plusCredentials);
      paymentUrl = String(qrResult.Data ?? "").trim();
    }
    if (!/^https:\/\//i.test(paymentUrl)) throw new TBankApiError("Т-Банк не вернул ссылку для оплаты");

    const updatedOrder = await prisma.subscriptionPayment.update({
      where: { id: order.id },
      data: { providerOperationId: tbankOperationId(paymentId), paymentUrl }
    });
    res.status(201).json({ order: serializeSubscriptionPayment(updatedOrder), paymentUrl });
  } catch (error) {
    await prisma.subscriptionPayment.update({
      where: { id: order.id },
      data: { status: "payment_error" }
    }).catch(() => undefined);
    const message = error instanceof TBankApiError
      ? error.message
      : "Не удалось связаться с Т-Банком. Попробуйте позже";
    res.status(502).json({ error: message });
  }
}));

paymentsRouter.post("/orders", requireAuth, asyncHandler(async (req, res) => {
  if (env.STORE_PAYMENTS_ENABLED !== "true") {
    return void res.status(503).json({ error: "Пополнение Steam временно приостановлено" });
  }
  if (!isTBankConfigured() || !isResellCodesConfigured()) {
    return void res.status(503).json({ error: "Оплата или автоматическое пополнение Steam ещё не настроены" });
  }

  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return void res.status(400).json({ error: "Проверьте Steam-логин, сумму и способ оплаты" });
  }

  const steamAmountKopecks = Math.round(parsed.data.steamAmount * 100);
  const minKopecks = env.STEAM_TOPUP_MIN_RUB * 100;
  const maxKopecks = env.STEAM_TOPUP_MAX_RUB * 100;
  if (steamAmountKopecks < minKopecks || steamAmountKopecks > maxKopecks) {
    return void res.status(400).json({
      error: `Сумма пополнения должна быть от ${env.STEAM_TOPUP_MIN_RUB} до ${env.STEAM_TOPUP_MAX_RUB} ₽`
    });
  }

  try {
    const loginCheck = await checkSteamLogin(parsed.data.steamLogin);
    if (!loginCheck.can_refill) {
      return void res.status(400).json({ error: "Этот Steam-логин не может принять пополнение" });
    }
  } catch (error) {
    const message = error instanceof ResellCodesApiError && error.status === 400
      ? error.message
      : "Не удалось проверить Steam-логин. Попробуйте позже";
    return void res.status(error instanceof ResellCodesApiError && error.status === 400 ? 400 : 502).json({ error: message });
  }

  const customer = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: { email: true, phone: true }
  });
  if (!customer) return void res.status(401).json({ error: "Пользователь не найден" });

  const serviceFeeKopecks = Math.round(steamAmountKopecks * env.STEAM_TOPUP_MARKUP_PERCENT / 100);
  const paymentAmountKopecks = steamAmountKopecks + serviceFeeKopecks;
  let receipt: ReturnType<typeof buildReceipt>;
  try {
    receipt = buildReceipt(customer, paymentAmountKopecks, "Пополнение баланса Steam через GVoice");
  } catch (error) {
    return void res.status(503).json({
      error: error instanceof Error ? error.message : "Не удалось подготовить электронный чек"
    });
  }

  const order = await prisma.paymentOrder.create({
    data: {
      userId: req.auth!.userId,
      provider: "tbank",
      paymentMethod: parsed.data.paymentMethod,
      currency: "RUB",
      steamLogin: parsed.data.steamLogin,
      steamAmountKopecks,
      serviceFeeKopecks,
      paymentAmountKopecks
    }
  });

  try {
    const initResult = await tbankRequest("Init", {
      Amount: paymentAmountKopecks,
      OrderId: order.id,
      Description: `Пополнение Steam для ${parsed.data.steamLogin}`.slice(0, 140),
      PayType: "O",
      Language: env.TBANK_LANGUAGE,
      NotificationURL: env.TBANK_NOTIFICATION_URL,
      SuccessURL: env.TBANK_SUCCESS_URL,
      FailURL: env.TBANK_FAIL_URL,
      DATA: { connection_type: "Widget" },
      ...(receipt ? { Receipt: receipt } : {})
    });
    const paymentId = String(initResult.PaymentId ?? "").trim();
    if (!paymentId) throw new TBankApiError("Т-Банк не вернул идентификатор платежа");

    let paymentUrl = String(initResult.PaymentURL ?? "").trim();
    if (parsed.data.paymentMethod === "sbp") {
      const qrResult = await tbankRequest("GetQr", {
        PaymentId: paymentId,
        DataType: "PAYLOAD",
        PaymentMethod: "SBP"
      });
      paymentUrl = String(qrResult.Data ?? "").trim();
    }
    if (!/^https:\/\//i.test(paymentUrl)) {
      throw new TBankApiError("Т-Банк не вернул ссылку для оплаты");
    }

    const updatedOrder = await prisma.paymentOrder.update({
      where: { id: order.id },
      data: { providerOperationId: tbankOperationId(paymentId) }
    });
    res.status(201).json({ order: serializeOrder(updatedOrder), paymentUrl });
  } catch (error) {
    await prisma.paymentOrder.update({
      where: { id: order.id },
      data: { status: "payment_error" }
    }).catch(() => undefined);
    const message = error instanceof TBankApiError
      ? error.message
      : "Не удалось связаться с Т-Банком. Попробуйте позже";
    res.status(502).json({ error: message });
  }
}));

paymentsRouter.get("/orders/:orderId", requireAuth, asyncHandler(async (req, res) => {
  const order = await prisma.paymentOrder.findFirst({
    where: { id: req.params.orderId, userId: req.auth!.userId }
  });
  if (!order) return void res.status(404).json({ error: "Заказ не найден" });
  res.setHeader("Cache-Control", "no-store");
  res.json({ order: serializeOrder(order) });
}));

paymentsRouter.get("/orders", requireAuth, asyncHandler(async (req, res) => {
  const orders = await prisma.paymentOrder.findMany({
    where: { userId: req.auth!.userId },
    orderBy: { createdAt: "desc" },
    take: 30
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ orders: orders.map(serializeOrder) });
}));

paymentsRouter.post("/tbank/plus/webhook", asyncHandler(async (req, res) => {
  res.type("text/plain");
  const plusCredentials = getTBankPlusCredentials();
  if (!plusCredentials) return void res.status(503).send("NOT CONFIGURED");
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return void res.status(400).send("INVALID REQUEST");
  }

  const rawNotification = req.body as TBankPayload;
  const parsed = notificationSchema.safeParse(rawNotification);
  if (!parsed.success) return void res.status(400).send("INVALID REQUEST");
  const notification = parsed.data;

  if (notification.TerminalKey !== plusCredentials.terminalKey) {
    return void res.status(400).send("WRONG TERMINAL");
  }
  const expectedToken = createTBankToken(rawNotification, plusCredentials.password);
  if (!safeEqual(expectedToken, notification.Token)) {
    return void res.status(400).send("WRONG TOKEN");
  }

  const subscriptionPayment = await prisma.subscriptionPayment.findUnique({
    where: { id: notification.OrderId }
  });
  if (!subscriptionPayment) return void res.status(404).send("ORDER NOT FOUND");

  const paymentId = String(notification.PaymentId);
  const operationId = tbankOperationId(paymentId);
  if (subscriptionPayment.provider !== "tbank"
    || notification.Amount !== subscriptionPayment.paymentAmountKopecks
    || (subscriptionPayment.providerOperationId && subscriptionPayment.providerOperationId !== operationId)) {
    return void res.status(400).send("PAYMENT MISMATCH");
  }

  const status = notification.Status.toUpperCase();
  const notificationSucceeded = notification.Success === true || notification.Success === "true";
  const rebillId = notification.RebillId == null ? null : String(notification.RebillId);
  if (status === "CONFIRMED" && notificationSucceeded) {
    await activateSubscriptionPayment(subscriptionPayment.id, operationId, rebillId);
  } else if (status === "AUTHORIZED" && notificationSucceeded) {
    await prisma.subscriptionPayment.updateMany({
      where: { id: subscriptionPayment.id, status: "pending" },
      data: { status: "authorized", providerOperationId: operationId, providerRebillId: rebillId }
    });
  } else if (["REFUNDING", "REVERSING"].includes(status)) {
    await prisma.subscriptionPayment.update({
      where: { id: subscriptionPayment.id },
      data: { status: "refund_pending", providerOperationId: operationId }
    });
  } else if (status === "REVERSED") {
    await prisma.subscriptionPayment.update({
      where: { id: subscriptionPayment.id },
      data: { status: "reversed", providerOperationId: operationId }
    });
  } else if (["REJECTED", "CANCELED", "DEADLINE_EXPIRED"].includes(status)) {
    await prisma.subscriptionPayment.updateMany({
      where: { id: subscriptionPayment.id, status: { in: ["pending", "authorized"] } },
      data: { status: status.toLowerCase(), providerOperationId: operationId }
    });
  } else if (["REFUNDED", "PARTIAL_REFUNDED"].includes(status)) {
    await prisma.subscriptionPayment.update({
      where: { id: subscriptionPayment.id },
      data: { status: status.toLowerCase(), providerOperationId: operationId }
    });
  }

  res.send("OK");
}));

paymentsRouter.post("/tbank/webhook", asyncHandler(async (req, res) => {
  res.type("text/plain");
  const credentials = getTBankCredentials();
  if (!credentials) return void res.status(503).send("NOT CONFIGURED");
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return void res.status(400).send("INVALID REQUEST");
  }

  const rawNotification = req.body as TBankPayload;
  const parsed = notificationSchema.safeParse(rawNotification);
  if (!parsed.success) return void res.status(400).send("INVALID REQUEST");
  const notification = parsed.data;

  if (notification.TerminalKey !== credentials.terminalKey) {
    return void res.status(400).send("WRONG TERMINAL");
  }
  const expectedToken = createTBankToken(rawNotification, credentials.password);
  if (!safeEqual(expectedToken, notification.Token)) {
    return void res.status(400).send("WRONG TOKEN");
  }

  const gameTopupOrder = await prisma.gameTopupOrder.findUnique({ where: { id: notification.OrderId } });
  if (gameTopupOrder) {
    const paymentId = String(notification.PaymentId);
    const operationId = tbankOperationId(paymentId);
    if (gameTopupOrder.provider !== "tbank"
      || notification.Amount !== gameTopupOrder.paymentAmountKopecks
      || (gameTopupOrder.providerOperationId && gameTopupOrder.providerOperationId !== operationId)) {
      return void res.status(400).send("PAYMENT MISMATCH");
    }
    const status = notification.Status.toUpperCase();
    const notificationSucceeded = notification.Success === true || notification.Success === "true";
    if (status === "CONFIRMED" && notificationSucceeded) {
      await prisma.gameTopupOrder.updateMany({
        where: { id: gameTopupOrder.id, status: { in: ["pending", "authorized"] } },
        data: { status: "paid", fulfillmentStatus: "ready", providerOperationId: operationId, paidAt: new Date() }
      });
    } else if (status === "AUTHORIZED" && notificationSucceeded) {
      await prisma.gameTopupOrder.updateMany({
        where: { id: gameTopupOrder.id, status: "pending" },
        data: { status: "authorized", providerOperationId: operationId }
      });
    } else if (["REFUNDING", "REVERSING"].includes(status)) {
      await prisma.gameTopupOrder.update({
        where: { id: gameTopupOrder.id },
        data: { status: "refund_pending", fulfillmentStatus: "refund_pending", providerOperationId: operationId }
      });
    } else if (["REFUNDED", "REVERSED"].includes(status)) {
      await prisma.gameTopupOrder.update({
        where: { id: gameTopupOrder.id },
        data: { status: status.toLowerCase(), fulfillmentStatus: "refunded", providerOperationId: operationId }
      });
    } else if (["REJECTED", "CANCELED", "DEADLINE_EXPIRED"].includes(status)) {
      await prisma.gameTopupOrder.updateMany({
        where: { id: gameTopupOrder.id, status: { in: ["pending", "authorized"] } },
        data: { status: status.toLowerCase(), providerOperationId: operationId }
      });
    }
    res.send("OK");
    return;
  }

  const order = await prisma.paymentOrder.findUnique({ where: { id: notification.OrderId } });
  if (!order) return void res.status(404).send("ORDER NOT FOUND");
  const paymentId = String(notification.PaymentId);
  const operationId = tbankOperationId(paymentId);
  if (order.provider !== "tbank"
    || notification.Amount !== order.paymentAmountKopecks
    || (order.providerOperationId && order.providerOperationId !== operationId)) {
    return void res.status(400).send("PAYMENT MISMATCH");
  }

  const status = notification.Status.toUpperCase();
  const notificationSucceeded = notification.Success === true || notification.Success === "true";
  if (status === "CONFIRMED" && notificationSucceeded) {
    await prisma.paymentOrder.updateMany({
      where: { id: order.id, status: { in: ["pending", "authorized"] } },
      data: {
        status: "paid",
        fulfillmentStatus: "ready",
        providerOperationId: operationId,
        paidAt: new Date()
      }
    });
  } else if (status === "AUTHORIZED" && notificationSucceeded) {
    await prisma.paymentOrder.updateMany({
      where: { id: order.id, status: "pending" },
      data: { status: "authorized", providerOperationId: operationId }
    });
  } else if (["REFUNDING", "REVERSING"].includes(status)) {
    await prisma.paymentOrder.update({
      where: { id: order.id },
      data: { status: "refund_pending", fulfillmentStatus: "refund_pending", providerOperationId: operationId }
    });
  } else if (status === "REVERSED") {
    await prisma.paymentOrder.update({
      where: { id: order.id },
      data: { status: "reversed", fulfillmentStatus: "refunded", providerOperationId: operationId }
    });
  } else if (["REJECTED", "CANCELED", "DEADLINE_EXPIRED"].includes(status)) {
    await prisma.paymentOrder.updateMany({
      where: { id: order.id, status: { in: ["pending", "authorized", "cancel_pending"] } },
      data: {
        status: status.toLowerCase(),
        fulfillmentStatus: status === "REFUNDED" ? "refunded" : "review_required",
        providerOperationId: operationId
      }
    });
  } else if (["REFUNDED", "PARTIAL_REFUNDED"].includes(status)) {
    await prisma.paymentOrder.update({
      where: { id: order.id },
      data: { status: status.toLowerCase(), providerOperationId: operationId }
    });
  }

  res.send("OK");
}));
