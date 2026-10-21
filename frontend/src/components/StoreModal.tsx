import { useCallback, useEffect, useMemo, useState } from "react";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import "./StoreModal.css";
import { TBankPaymentFrame } from "./TBankPaymentFrame";
import type { LegalTab } from "./LegalPage";

type StoreModalProps = {
  open: boolean;
  onClose: () => void;
  onOpenLegal: (tab: LegalTab) => void;
  onOpenSupport: () => void;
  authorizedFetch: (path: string, init?: RequestInit) => Promise<Response>;
};

type CheckoutStage = "form" | "payment" | "success";
type StoreView = "plus" | "checkout" | "games" | "history";
type PaymentMethod = "card" | "sbp";
type PaymentOrder = {
  id: string;
  status: string;
  fulfillmentStatus: string;
  paymentMethod: PaymentMethod;
  currency: string;
  steamLogin: string;
  steamAmount: string;
  serviceFee: string;
  paymentAmount: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  supplierOrderNumber: number | null;
  supplierStatus: string | null;
  supplierStatusReason: string | null;
  supplierFailCode: string | null;
  createdAt: string;
};

type CreateOrderResponse = { order: PaymentOrder; paymentUrl: string };

type GVoicePlusConfig = {
  enabled: boolean;
  terminalKey: string | null;
  plan: string;
  name: string;
  priceRub: number;
  billingPeriodDays: number;
  recurring: boolean;
};

type Subscription = {
  active: boolean;
  status: string | null;
  plan: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  canceledAt: string | null;
  autoRenew: boolean;
  nextChargeAt: string | null;
};

type SubscriptionOrder = {
  id: string;
  status: string;
  plan: string;
  billingPeriodDays: number;
  currency: string;
  paymentMethod: PaymentMethod;
  paymentAmount: string;
  paymentUrl: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  appliedAt: string | null;
  createdAt: string;
};

type CreateSubscriptionOrderResponse = { order: SubscriptionOrder; paymentUrl: string; reused?: boolean };

type GameTopupCategory = {
  categoryId: string;
  name: string;
  region: string;
  variant: string | null;
  image: string | null;
  note: string | null;
};

type GameTopupBrand = { brand: string; subcategories: GameTopupCategory[] };
type GameTopupField = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  placeholder: string | null;
  options: Array<string | { value: string; label?: string }>;
};
type GameTopupOffer = { offerId: string; name: string; priceRub: string; available: boolean };
type GameTopupCatalog = {
  brand: string;
  category: GameTopupCategory;
  fields: GameTopupField[];
  offers: GameTopupOffer[];
  pricing: { currency: string; markupPercent: number; fxBufferPercent: number };
};
type GameTopupOrder = {
  id: string;
  status: string;
  fulfillmentStatus: string;
  paymentMethod: PaymentMethod;
  currency: string;
  brand: string;
  categoryId: string;
  categoryName: string;
  offerId: string;
  offerName: string;
  region: string | null;
  variant: string | null;
  customerFields: Record<string, string>;
  paymentAmount: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  supplierStatus: string | null;
  supplierStatusReason: string | null;
  supplierFailCode: string | null;
  createdAt: string;
};
type CreateGameTopupOrderResponse = { order: GameTopupOrder; paymentUrl: string };

type PaymentConfig = {
  enabled?: boolean;
  configured: boolean;
  terminalKey: string | null;
  currency: string;
  minSteamAmount: number;
  maxSteamAmount: number;
  markupPercent: number;
  gvoicePlus: GVoicePlusConfig;
  gameTopups: { enabled: boolean; markupPercent: number; fxBufferPercent: number; brands: string[] };
};

const DEFAULT_CONFIG: PaymentConfig = {
  configured: true,
  terminalKey: null,
  currency: "RUB",
  minSteamAmount: 10,
  maxSteamAmount: 15000,
  markupPercent: 8,
  gvoicePlus: { enabled: false, terminalKey: null, plan: "gvoice_plus", name: "GVoice+", priceRub: 250, billingPeriodDays: 30, recurring: true },
  gameTopups: { enabled: false, markupPercent: 10, fxBufferPercent: 3, brands: ["PUBG Mobile", "Free Fire", "Mobile Legends"] }
};
const QUICK_AMOUNTS = [500, 1000, 2000, 5000];

function formatRub(value: number) {
  return value.toLocaleString("ru-RU", {
    style: "currency",
    currency: "RUB",
    minimumFractionDigits: value % 1 === 0 ? 0 : 2
  });
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) throw new Error((payload as { error?: string } | null)?.error ?? "Не удалось выполнить запрос");
  return payload as T;
}

function isFinalFulfillment(status: string) {
  return ["completed", "failed", "refunded", "review_required"].includes(status);
}

function formatOrderDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function orderStatus(order: PaymentOrder) {
  if (order.fulfillmentStatus === "completed") return { label: "Зачислено", tone: "success" };
  if (order.fulfillmentStatus === "refunded" || order.status === "refunded") return { label: "Возврат", tone: "warning" };
  if (order.fulfillmentStatus === "refund_pending" || order.status === "refund_pending") {
    return { label: "Возврат оформляется", tone: "processing" };
  }
  if (order.status === "cancel_pending") return { label: "Отменяется", tone: "processing" };
  if (order.fulfillmentStatus === "review_required") return { label: "Нужна проверка", tone: "warning" };
  if (order.fulfillmentStatus === "failed") return { label: "Ошибка зачисления", tone: "error" };
  if (["rejected", "canceled", "reversed", "deadline_expired", "payment_error"].includes(order.status)) {
    return { label: order.status === "canceled" ? "Отменён" : "Оплата не прошла", tone: "error" };
  }
  if (order.status === "paid" || order.status === "authorized") return { label: "В обработке", tone: "processing" };
  return { label: "Ожидает оплаты", tone: "pending" };
}

function PaymentMethodPicker({
  value,
  onChange,
  subscription = false
}: {
  value: PaymentMethod;
  onChange: (method: PaymentMethod) => void;
  subscription?: boolean;
}) {
  return (
    <div className="gvoice-store-payment-choice">
      <b>Способ оплаты</b>
      <div className="gvoice-store-payment-methods" role="radiogroup" aria-label="Способ оплаты">
        <button className={value === "card" ? "active" : ""} type="button" role="radio" aria-checked={value === "card"} onClick={() => onChange("card")}>
          <span className="gvoice-store-payment-method-icon">▰</span>
          <span><strong>Банковская карта</strong><small>{subscription ? "С автопродлением" : "Разовая оплата"}</small></span>
        </button>
        <button className={value === "sbp" ? "active" : ""} type="button" role="radio" aria-checked={value === "sbp"} onClick={() => onChange("sbp")}>
          <span className="gvoice-store-payment-method-icon gvoice-store-sbp-icon">СБП</span>
          <span><strong>СБП</strong><small>{subscription ? "30 дней без автосписания" : "Разовая оплата"}</small></span>
        </button>
      </div>
      <small>{subscription && value === "sbp"
        ? "СБП сейчас оплачивает один период на 30 дней. Автоматических списаний не будет."
        : "Платёж подтверждается Т‑Банком; GVoice не получает данные банковской карты."}</small>
    </div>
  );
}

export function StoreModal({ open, onClose, onOpenLegal, onOpenSupport, authorizedFetch }: StoreModalProps) {
  const [view, setView] = useState<StoreView>("plus");
  const [steamLogin, setSteamLogin] = useState("");
  const [steamAmount, setSteamAmount] = useState("500");
  const [stage, setStage] = useState<CheckoutStage>("form");
  const [order, setOrder] = useState<PaymentOrder | null>(null);
  const [paymentUrl, setPaymentUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<PaymentConfig>(DEFAULT_CONFIG);
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("card");
  const [historyOrders, setHistoryOrders] = useState<PaymentOrder[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [subscriptionOrders, setSubscriptionOrders] = useState<SubscriptionOrder[]>([]);
  const [plusStage, setPlusStage] = useState<CheckoutStage>("form");
  const [plusOrder, setPlusOrder] = useState<SubscriptionOrder | null>(null);
  const [plusPaymentUrl, setPlusPaymentUrl] = useState("");
  const [plusLegalAccepted, setPlusLegalAccepted] = useState(false);
  const [plusPaymentMethod, setPlusPaymentMethod] = useState<PaymentMethod>("card");
  const [plusSubmitting, setPlusSubmitting] = useState(false);
  const [plusChecking, setPlusChecking] = useState(false);
  const [plusError, setPlusError] = useState<string | null>(null);
  const [plusCanceling, setPlusCanceling] = useState(false);
  const [gameBrands, setGameBrands] = useState<GameTopupBrand[]>([]);
  const [gameCategoryId, setGameCategoryId] = useState("");
  const [gameCatalog, setGameCatalog] = useState<GameTopupCatalog | null>(null);
  const [gameOfferId, setGameOfferId] = useState("");
  const [gameFields, setGameFields] = useState<Record<string, string>>({});
  const [gameLegalAccepted, setGameLegalAccepted] = useState(false);
  const [gamePaymentMethod, setGamePaymentMethod] = useState<PaymentMethod>("card");
  const [gameStage, setGameStage] = useState<CheckoutStage>("form");
  const [gameOrder, setGameOrder] = useState<GameTopupOrder | null>(null);
  const [gamePaymentUrl, setGamePaymentUrl] = useState("");
  const [gameLoading, setGameLoading] = useState(false);
  const [gameSubmitting, setGameSubmitting] = useState(false);
  const [gameChecking, setGameChecking] = useState(false);
  const [gameError, setGameError] = useState<string | null>(null);
  const [gameHistoryOrders, setGameHistoryOrders] = useState<GameTopupOrder[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const nativePayment = Capacitor.isNativePlatform();

  const price = useMemo(() => {
    const rawAmount = Number(steamAmount.replace(",", "."));
    const amount = Number.isFinite(rawAmount) && rawAmount > 0 ? Math.round(rawAmount * 100) / 100 : 0;
    const markup = Math.round(amount * config.markupPercent) / 100;
    return { amount, markup, total: Math.round((amount + markup) * 100) / 100 };
  }, [config.markupPercent, steamAmount]);

  useEffect(() => {
    if (!open) return;
    void authorizedFetch("/payments/config", { cache: "no-store" })
      .then((response) => readJson<PaymentConfig>(response))
      .then((payload) => setConfig({
        ...DEFAULT_CONFIG,
        ...payload,
        gvoicePlus: payload.gvoicePlus ?? DEFAULT_CONFIG.gvoicePlus,
        gameTopups: payload.gameTopups ?? DEFAULT_CONFIG.gameTopups
      }))
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : "Не удалось загрузить настройки оплаты"));
  }, [authorizedFetch, open]);

  const loadSubscription = useCallback(async () => {
    const response = await authorizedFetch("/payments/subscriptions/me", { cache: "no-store" });
    const payload = await readJson<{ subscription: Subscription; pendingPayment: SubscriptionOrder | null }>(response);
    setSubscription(payload.subscription);
    if (payload.pendingPayment?.paymentUrl) {
      setPlusOrder(payload.pendingPayment);
      setPlusPaymentUrl(payload.pendingPayment.paymentUrl);
      setPlusPaymentMethod(payload.pendingPayment.paymentMethod === "sbp" ? "sbp" : "card");
      setPlusStage("payment");
      setPlusError(null);
    }
  }, [authorizedFetch]);

  useEffect(() => {
    if (!open) return;
    void loadSubscription().catch((requestError) => {
      setPlusError(requestError instanceof Error ? requestError.message : "Не удалось загрузить GVoice+");
    });
  }, [loadSubscription, open]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const [steamResponse, subscriptionResponse, gameResponse] = await Promise.all([
        authorizedFetch("/payments/orders", { cache: "no-store" }),
        authorizedFetch("/payments/subscriptions/orders", { cache: "no-store" }),
        authorizedFetch("/payments/game-topups/orders", { cache: "no-store" })
      ]);
      const steamPayload = await readJson<{ orders: PaymentOrder[] }>(steamResponse);
      const subscriptionPayload = await readJson<{ orders: SubscriptionOrder[] }>(subscriptionResponse);
      const gamePayload = await readJson<{ orders: GameTopupOrder[] }>(gameResponse);
      setHistoryOrders(steamPayload.orders);
      setSubscriptionOrders(subscriptionPayload.orders);
      setGameHistoryOrders(gamePayload.orders);
    } catch (requestError) {
      setHistoryError(requestError instanceof Error ? requestError.message : "Не удалось загрузить историю платежей");
    } finally {
      setHistoryLoading(false);
    }
  }, [authorizedFetch]);

  useEffect(() => {
    if (!open || view !== "history") return;
    void loadHistory();
  }, [loadHistory, open, view]);

  const checkOrder = useCallback(async (showProgress = false) => {
    if (!order?.id) return;
    if (showProgress) setChecking(true);
    try {
      const response = await authorizedFetch(`/payments/orders/${order.id}`, { cache: "no-store" });
      const payload = await readJson<{ order: PaymentOrder }>(response);
      setOrder(payload.order);
      if (payload.order.status === "paid") {
        setStage("success");
        setError(null);
      } else if (["rejected", "canceled", "reversed", "deadline_expired", "payment_error"].includes(payload.order.status)) {
        setError("Платёж не завершён. Вернитесь к оформлению и попробуйте снова.");
      }
    } catch (requestError) {
      if (showProgress) setError(requestError instanceof Error ? requestError.message : "Не удалось проверить оплату");
    } finally {
      if (showProgress) setChecking(false);
    }
  }, [authorizedFetch, order?.id]);

  useEffect(() => {
    if (!open || !order?.id || (stage !== "payment" && stage !== "success") || isFinalFulfillment(order.fulfillmentStatus)) return;
    const timer = window.setInterval(() => void checkOrder(false), 3000);
    return () => window.clearInterval(timer);
  }, [checkOrder, open, order?.fulfillmentStatus, order?.id, stage]);

  useEffect(() => {
    if (!nativePayment || stage !== "success") return;
    void Browser.close().catch(() => undefined);
  }, [nativePayment, stage]);

  const checkPlusOrder = useCallback(async (showProgress = false) => {
    if (!plusOrder?.id) return;
    if (showProgress) setPlusChecking(true);
    try {
      const response = await authorizedFetch(`/payments/subscriptions/orders/${plusOrder.id}`, { cache: "no-store" });
      const payload = await readJson<{ order: SubscriptionOrder }>(response);
      setPlusOrder(payload.order);
      if (payload.order.status === "paid") {
        setPlusStage("success");
        setPlusError(null);
        await loadSubscription();
      } else if (["rejected", "canceled", "reversed", "deadline_expired", "payment_error"].includes(payload.order.status)) {
        setPlusError(payload.order.status === "deadline_expired"
          ? "Время оплаты истекло. Заявка отменена, можно оформить новую."
          : "Платёж не завершён. Вернитесь к оформлению и попробуйте снова.");
      }
    } catch (requestError) {
      if (showProgress) setPlusError(requestError instanceof Error ? requestError.message : "Не удалось проверить оплату");
    } finally {
      if (showProgress) setPlusChecking(false);
    }
  }, [authorizedFetch, loadSubscription, plusOrder?.id]);

  useEffect(() => {
    if (!open || !plusOrder?.id || plusStage !== "payment") return;
    const timer = window.setInterval(() => void checkPlusOrder(false), 3000);
    return () => window.clearInterval(timer);
  }, [checkPlusOrder, open, plusOrder?.id, plusStage]);

  useEffect(() => {
    if (!nativePayment || plusStage !== "success") return;
    void Browser.close().catch(() => undefined);
  }, [nativePayment, plusStage]);

  useEffect(() => {
    if (!open || view !== "games" || gameBrands.length > 0) return;
    setGameLoading(true);
    setGameError(null);
    void authorizedFetch("/payments/game-topups/brands", { cache: "no-store" })
      .then((response) => readJson<{ brands: GameTopupBrand[] }>(response))
      .then((payload) => {
        setGameBrands(payload.brands);
        const firstCategory = payload.brands[0]?.subcategories[0]?.categoryId;
        if (firstCategory) setGameCategoryId(firstCategory);
      })
      .catch((requestError) => setGameError(requestError instanceof Error ? requestError.message : "Не удалось загрузить игры"))
      .finally(() => setGameLoading(false));
  }, [authorizedFetch, gameBrands.length, open, view]);

  useEffect(() => {
    if (!open || view !== "games" || !gameCategoryId) return;
    setGameLoading(true);
    setGameError(null);
    setGameCatalog(null);
    setGameOfferId("");
    setGameFields({});
    void authorizedFetch(`/payments/game-topups/categories/${encodeURIComponent(gameCategoryId)}/offers`, { cache: "no-store" })
      .then((response) => readJson<GameTopupCatalog>(response))
      .then((payload) => {
        setGameCatalog(payload);
        const firstOffer = payload.offers.find((offer) => offer.available);
        if (firstOffer) setGameOfferId(firstOffer.offerId);
      })
      .catch((requestError) => setGameError(requestError instanceof Error ? requestError.message : "Не удалось загрузить варианты пополнения"))
      .finally(() => setGameLoading(false));
  }, [authorizedFetch, gameCategoryId, open, view]);

  const checkGameOrder = useCallback(async (showProgress = false) => {
    if (!gameOrder?.id) return;
    if (showProgress) setGameChecking(true);
    try {
      const response = await authorizedFetch(`/payments/game-topups/orders/${gameOrder.id}`, { cache: "no-store" });
      const payload = await readJson<{ order: GameTopupOrder }>(response);
      setGameOrder(payload.order);
      if (payload.order.status === "paid") setGameStage("success");
      if (["rejected", "canceled", "reversed", "deadline_expired", "payment_error"].includes(payload.order.status)) {
        setGameError("Платёж не завершён. Можно вернуться к выбору пакета.");
      }
    } catch (requestError) {
      if (showProgress) setGameError(requestError instanceof Error ? requestError.message : "Не удалось проверить заказ");
    } finally {
      if (showProgress) setGameChecking(false);
    }
  }, [authorizedFetch, gameOrder?.id]);

  useEffect(() => {
    if (!open || !gameOrder?.id || (gameStage !== "payment" && gameStage !== "success") || isFinalFulfillment(gameOrder.fulfillmentStatus)) return;
    const timer = window.setInterval(() => void checkGameOrder(false), 3000);
    return () => window.clearInterval(timer);
  }, [checkGameOrder, gameOrder?.fulfillmentStatus, gameOrder?.id, gameStage, open]);

  useEffect(() => {
    if (!nativePayment || gameStage !== "success") return;
    void Browser.close().catch(() => undefined);
  }, [gameStage, nativePayment]);

  if (!open) return null;

  const orderDataValid = steamLogin.trim().length >= 2 && price.amount >= config.minSteamAmount && price.amount <= config.maxSteamAmount;
  const canContinue = config.configured && orderDataValid && legalAccepted;
  const reset = () => {
    setStage("form");
    setOrder(null);
    setPaymentUrl("");
    setSubmitting(false);
    setChecking(false);
    setError(null);
    setLegalAccepted(false);
    setPaymentMethod("card");
  };
  const resetPlus = () => {
    setPlusStage("form");
    setPlusOrder(null);
    setPlusPaymentUrl("");
    setPlusLegalAccepted(false);
    setPlusPaymentMethod("card");
    setPlusSubmitting(false);
    setPlusChecking(false);
    setPlusError(null);
  };
  const resetGame = () => {
    setGameStage("form");
    setGameOrder(null);
    setGamePaymentUrl("");
    setGameLegalAccepted(false);
    setGamePaymentMethod("card");
    setGameSubmitting(false);
    setGameChecking(false);
    setGameError(null);
  };
  const close = () => {
    reset();
    resetPlus();
    resetGame();
    setView("plus");
    onClose();
  };

  const startPayment = async () => {
    if (!canContinue || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await authorizedFetch("/payments/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steamLogin: steamLogin.trim(), steamAmount: price.amount, paymentMethod })
      });
      const payload = await readJson<CreateOrderResponse>(response);
      setOrder(payload.order);
      setPaymentUrl(payload.paymentUrl);
      setStage("payment");
      if (nativePayment) {
        await Browser.open({ url: payload.paymentUrl, presentationStyle: "popover" });
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось создать платёж");
    } finally {
      setSubmitting(false);
    }
  };

  const startPlusPayment = async () => {
    if (!config.gvoicePlus.enabled || !plusLegalAccepted || plusSubmitting) return;
    setPlusSubmitting(true);
    setPlusError(null);
    try {
      const response = await authorizedFetch("/payments/subscriptions/gvoice-plus/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethod: plusPaymentMethod,
          purchaseConsent: true,
          recurringConsent: plusPaymentMethod === "card"
        })
      });
      const payload = await readJson<CreateSubscriptionOrderResponse>(response);
      setPlusOrder(payload.order);
      setPlusPaymentUrl(payload.paymentUrl);
      setPlusStage("payment");
      if (payload.reused) setPlusError("Мы вернули вас к уже созданной оплате. Новая заявка не создавалась.");
      if (nativePayment) await Browser.open({ url: payload.paymentUrl, presentationStyle: "popover" });
    } catch (requestError) {
      setPlusError(requestError instanceof Error ? requestError.message : "Не удалось создать платёж GVoice+");
    } finally {
      setPlusSubmitting(false);
    }
  };

  const cancelPlusRenewal = async () => {
    if (!subscription?.active || subscription.canceledAt || plusCanceling) return;
    setPlusCanceling(true);
    setPlusError(null);
    try {
      const response = await authorizedFetch("/payments/subscriptions/me/cancel-renewal", { method: "POST" });
      const payload = await readJson<{ subscription: Subscription }>(response);
      setSubscription(payload.subscription);
    } catch (requestError) {
      setPlusError(requestError instanceof Error ? requestError.message : "Не удалось отключить автопродление");
    } finally {
      setPlusCanceling(false);
    }
  };

  const startGamePayment = async () => {
    if (!config.gameTopups.enabled || !gameCatalog || !gameOfferId || !gameLegalAccepted || gameSubmitting) return;
    const allFieldsFilled = gameCatalog.fields.every((field) => Boolean(gameFields[field.key]?.trim()));
    if (!allFieldsFilled) {
      setGameError("Заполните все данные игрового аккаунта.");
      return;
    }
    setGameSubmitting(true);
    setGameError(null);
    try {
      const response = await authorizedFetch("/payments/game-topups/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId: gameCatalog.category.categoryId, offerId: gameOfferId, fields: gameFields, paymentMethod: gamePaymentMethod })
      });
      const payload = await readJson<CreateGameTopupOrderResponse>(response);
      setGameOrder(payload.order);
      setGamePaymentUrl(payload.paymentUrl);
      setGameStage("payment");
      if (nativePayment) await Browser.open({ url: payload.paymentUrl, presentationStyle: "popover" });
    } catch (requestError) {
      setGameError(requestError instanceof Error ? requestError.message : "Не удалось создать игровой заказ");
    } finally {
      setGameSubmitting(false);
    }
  };

  return (
    <div className="gvoice-store-overlay" onClick={close}>
      <section className="gvoice-store-modal" onClick={(event) => event.stopPropagation()}>
        <header className="gvoice-store-header">
          <div>
            <small>GVOICE STORE · БЕЗОПАСНАЯ ОПЛАТА</small>
            <h2>Подписка и сервисы GVoice</h2>
            <p>Официальная защищённая форма Т‑Банка открывается внутри GVoice.</p>
          </div>
          <button type="button" onClick={close} aria-label="Закрыть магазин">✕</button>
        </header>

        <nav className="gvoice-store-tabs" aria-label="Разделы магазина">
          <button className={view === "plus" ? "active" : ""} type="button" onClick={() => setView("plus")}>GVoice+</button>
          <button className={view === "checkout" ? "active" : ""} type="button" onClick={() => setView("checkout")}>Пополнить Steam</button>
          <button className={view === "games" ? "active" : ""} type="button" onClick={() => setView("games")}>Игровые пополнения</button>
          <button className={view === "history" ? "active" : ""} type="button" onClick={() => setView("history")}>История платежей</button>
        </nav>

        {view === "plus" && plusStage === "form" ? (
          <div className="gvoice-plus-page">
            <section className="gvoice-plus-hero">
              <div className="gvoice-plus-copy">
                <span className="gvoice-plus-badge">GVOICE+</span>
                <h3>Больше возможностей для общения и файлов</h3>
                <p>Единая подписка для активных пользователей GVoice. Получателю файла подписка не нужна.</p>
                {subscription?.active && subscription.currentPeriodEnd ? (
                  <div className="gvoice-plus-active">✓ Подписка активна до {formatOrderDate(subscription.currentPeriodEnd)}</div>
                ) : null}
              </div>
              <div className="gvoice-plus-price">
                <strong>{formatRub(config.gvoicePlus.priceRub)}</strong>
                <span>{plusPaymentMethod === "card" ? `каждые ${config.gvoicePlus.billingPeriodDays} дней` : `за ${config.gvoicePlus.billingPeriodDays} дней`}</span>
                <small>{plusPaymentMethod === "card" ? "Автоматическое списание до отмены подписки" : "Разовая оплата через СБП"}</small>
              </div>
            </section>

            <div className="gvoice-plus-features">
              <article><span>☁️</span><div><b>50 ГБ личного облака</b><small>Мои файлы: видео, фото, документы и архивы с поиском.</small></div></article>
              <article><span>📦</span><div><b>Файлы до 5 ГБ</b><small>Получатель скачает файл даже без GVoice+.</small></div></article>
              <article><span>🎙️</span><div><b>Voice → Text</b><small>Расшифровка голосовых сообщений в один клик.</small></div></article>
              <article><span>🌍</span><div><b>Перевод сообщений</b><small>Ручной перевод и автоматический перевод выбранных собеседников.</small></div></article>
              <article><span>🔎</span><div><b>Расширенный поиск</b><small>По людям, датам, типам вложений и запросам обычным языком.</small></div></article>
              <article><span>🎨</span><div><b>Кастомизация</b><small>Темы, фоны, анимированные аватары, цвета, звуки и иконки.</small></div></article>
            </div>

            <section className="gvoice-plus-action">
              <PaymentMethodPicker value={plusPaymentMethod} onChange={(method) => {
                setPlusPaymentMethod(method);
                setPlusLegalAccepted(false);
              }} subscription />
              <div className="gvoice-plus-renewal-details">
                <b>{plusPaymentMethod === "card" ? "Условия регулярной подписки" : "Условия разовой оплаты СБП"}</b>
                <span>Стоимость — <b>{formatRub(config.gvoicePlus.priceRub)} {plusPaymentMethod === "card" ? `каждые ${config.gvoicePlus.billingPeriodDays} дней` : `за ${config.gvoicePlus.billingPeriodDays} дней`}</b>.</span>
                {plusPaymentMethod === "card" ? (
                  <>
                    <span>После первой оплаты платёжные реквизиты сохраняются у Т‑Банка. Следующие списания выполняются автоматически раз в {config.gvoicePlus.billingPeriodDays} дней до отмены подписки.</span>
                    <span>Автопродление можно отключить здесь в любой момент. Уже оплаченный период продолжит действовать до даты окончания.</span>
                  </>
                ) : (
                  <span>СБП включает GVoice+ на один период. Способ оплаты не сохраняется, повторных списаний не будет.</span>
                )}
                <span>Условия полного и частичного возврата описаны в <button className="gvoice-store-document-link" type="button" onClick={() => onOpenLegal("refund")}>правилах отмены и возврата</button>.</span>
              </div>
              <label className="gvoice-store-legal-consent">
                <input type="checkbox" checked={plusLegalAccepted} onChange={(event) => setPlusLegalAccepted(event.target.checked)} disabled={!config.gvoicePlus.enabled} />
                <span>{plusPaymentMethod === "card"
                  ? <>Я согласен на первое и последующие автоматические списания <b>{formatRub(config.gvoicePlus.priceRub)} каждые {config.gvoicePlus.billingPeriodDays} дней</b> с привязанной банковской карты до отмены подписки, принимаю <button className="gvoice-store-document-link" type="button" onClick={() => onOpenLegal("subscription")}>условия GVoice+</button> и <button className="gvoice-store-document-link" type="button" onClick={() => onOpenLegal("refund")}>правила возврата</button>.</>
                  : <>Я подтверждаю разовую оплату <b>{formatRub(config.gvoicePlus.priceRub)} за {config.gvoicePlus.billingPeriodDays} дней GVoice+</b> через СБП без автосписаний, принимаю <button className="gvoice-store-document-link" type="button" onClick={() => onOpenLegal("subscription")}>условия GVoice+</button> и <button className="gvoice-store-document-link" type="button" onClick={() => onOpenLegal("refund")}>правила возврата</button>.</>}
                </span>
              </label>
              <button className="gvoice-store-primary" type="button" disabled={!config.gvoicePlus.enabled || !plusLegalAccepted || plusSubmitting} onClick={() => void startPlusPayment()}>
                {plusSubmitting ? "Создаём платёж…" : plusPaymentMethod === "sbp" ? `Оплатить ${formatRub(config.gvoicePlus.priceRub)} через СБП` : subscription?.active ? "Подключить автопродление GVoice+" : "Оформить GVoice+ по карте"}
              </button>
              {subscription?.active ? (
                <div className="gvoice-plus-support">
                  <b>{subscription.autoRenew && !subscription.canceledAt ? "Автопродление включено" : "Автопродление отключено"}</b>
                  <span>
                    {subscription.autoRenew && subscription.nextChargeAt
                      ? `Следующее списание ${formatRub(config.gvoicePlus.priceRub)} — ${formatOrderDate(subscription.nextChargeAt)}.`
                      : `Новых списаний не будет. Доступ сохранится до ${subscription.currentPeriodEnd ? formatOrderDate(subscription.currentPeriodEnd) : "окончания оплаченного периода"}.`}
                  </span>
                  {subscription.autoRenew && !subscription.canceledAt ? (
                    <button className="gvoice-plus-support-button" type="button" disabled={plusCanceling} onClick={() => void cancelPlusRenewal()}>
                      {plusCanceling ? "Отключаем…" : "Отключить автопродление"}
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className="gvoice-plus-support">
                <b>Отмена подписки, возврат и вопросы</b>
                <span>Для отмены подписки, возврата или вопроса по списанию напишите во встроенную техподдержку GVoice.</span>
                <button className="gvoice-plus-support-button" type="button" onClick={onOpenSupport}>Открыть техподдержку</button>
              </div>
              {!config.gvoicePlus.enabled ? <small className="gvoice-plus-launch-note">Тариф уже в разработке. Оплата откроется после запуска заявленных возможностей.</small> : null}
              {plusError ? <small className="gvoice-store-error">{plusError}</small> : null}
            </section>
          </div>
        ) : null}

        {view === "plus" && plusStage === "payment" && plusOrder ? (
          <div className="gvoice-store-test-payment">
            <div className="gvoice-store-payment-title">
              <small>БЕЗОПАСНАЯ ОПЛАТА Т‑БАНКА</small>
              <h3>Оформление GVoice+</h3>
              <p>{plusOrder.paymentMethod === "card"
                ? `После первой оплаты GVoice+ включится на ${plusOrder.billingPeriodDays} дней, а дальнейшие списания будут выполняться автоматически каждые ${plusOrder.billingPeriodDays} дней до отмены.`
                : `После оплаты через СБП GVoice+ включится на ${plusOrder.billingPeriodDays} дней. Автоматических списаний не будет.`}</p>
            </div>
            {plusOrder.paymentMethod === "card" && !nativePayment && config.gvoicePlus.terminalKey ? (
              <TBankPaymentFrame terminalKey={config.gvoicePlus.terminalKey} paymentUrl={plusPaymentUrl} orderId={plusOrder.id}
                onStatusChange={(status) => {
                  if (status === "SUCCESS") void checkPlusOrder(true);
                  if (["CANCELED", "EXPIRED", "PROCESSING_ERROR", "REFUNDED", "REJECTED"].includes(status)) setPlusError("Платёж не завершён.");
                }}
                onError={(message) => setPlusError(message)} />
            ) : null}
            {plusOrder.paymentMethod === "sbp" ? (
              <div className="gvoice-store-sbp-payment">
                <span className="gvoice-store-sbp-mark">СБП</span>
                <div><b>Оплата через приложение банка</b><small>Откройте платёж, выберите свой банк и подтвердите перевод. GVoice автоматически увидит результат.</small></div>
                <a className="gvoice-store-payment-link" href={plusPaymentUrl} target="_blank" rel="noopener noreferrer">Перейти к оплате СБП</a>
              </div>
            ) : null}
            <div className="gvoice-store-order-summary">
              <span>Заказ: <b>{plusOrder.id}</b></span>
              <span>Тариф: <b>GVoice+</b></span>
              <span>Способ: <b>{plusOrder.paymentMethod === "sbp" ? "СБП" : "Банковская карта"}</b></span>
              <span>К оплате: <b>{formatRub(Number(plusOrder.paymentAmount))}</b></span>
              {plusOrder.expiresAt ? <span>Оплатить до: <b>{formatOrderDate(plusOrder.expiresAt)}</b></span> : null}
            </div>
            {plusError ? <small className="gvoice-store-error">{plusError}</small> : null}
            <footer>
              <button type="button" onClick={() => void checkPlusOrder(true)} disabled={plusChecking}>{plusChecking ? "Проверяем…" : "Проверить статус"}</button>
              {plusOrder.status === "pending" ? <a className="gvoice-store-payment-link" href={plusPaymentUrl} target="_blank" rel="noopener noreferrer">Продолжить оплату</a> : null}
              {["rejected", "canceled", "reversed", "deadline_expired", "payment_error"].includes(plusOrder.status) ? (
                <button type="button" onClick={resetPlus}>Оформить заново</button>
              ) : null}
            </footer>
          </div>
        ) : null}

        {view === "plus" && plusStage === "success" ? (
          <div className="gvoice-store-success">
            <span>✓</span><h3>GVoice+ активирован</h3>
            <p>{subscription?.currentPeriodEnd ? `Подписка действует до ${formatOrderDate(subscription.currentPeriodEnd)}.` : "Подписка успешно активирована."}</p>
            <button type="button" onClick={resetPlus}>Готово</button>
          </div>
        ) : null}

        {view === "games" && gameStage === "form" ? (
          <div className="gvoice-store-content">
            <div className="gvoice-store-checkout-grid">
              <div className="gvoice-store-form-card">
                <label>
                  <b>Игра, регион и способ доставки</b>
                  <select value={gameCategoryId} onChange={(event) => setGameCategoryId(event.target.value)} disabled={gameLoading || gameBrands.length === 0}>
                    {gameBrands.map((brand) => (
                      <optgroup key={brand.brand} label={brand.brand}>
                        {brand.subcategories.map((category) => (
                          <option key={category.categoryId} value={category.categoryId}>
                            {category.name} · {category.region}{category.variant ? ` · ${category.variant}` : ""}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                {gameCatalog?.category.note ? <div className="gvoice-game-note">{gameCatalog.category.note}</div> : null}
                <label>
                  <b>Пакет пополнения</b>
                  <select value={gameOfferId} onChange={(event) => setGameOfferId(event.target.value)} disabled={gameLoading || !gameCatalog}>
                    {gameCatalog?.offers.map((offer) => (
                      <option key={offer.offerId} value={offer.offerId} disabled={!offer.available}>
                        {offer.name} — {formatRub(Number(offer.priceRub))}{offer.available ? "" : " · нет в наличии"}
                      </option>
                    ))}
                  </select>
                </label>
                {gameCatalog?.fields.map((field) => (
                  <label key={field.key}>
                    <b>{field.label}</b>
                    {field.type.toLowerCase() === "select" && field.options.length > 0 ? (
                      <select value={gameFields[field.key] ?? ""} onChange={(event) => setGameFields((current) => ({ ...current, [field.key]: event.target.value }))}>
                        <option value="">Выберите значение</option>
                        {field.options.map((option) => {
                          const value = typeof option === "string" ? option : option.value;
                          const label = typeof option === "string" ? option : option.label ?? option.value;
                          return <option key={value} value={value}>{label}</option>;
                        })}
                      </select>
                    ) : (
                      <input type={field.type.toLowerCase() === "number" ? "text" : "text"} inputMode={field.type.toLowerCase() === "number" ? "numeric" : "text"}
                        value={gameFields[field.key] ?? ""} placeholder={field.placeholder ?? field.label} maxLength={256}
                        onChange={(event) => setGameFields((current) => ({ ...current, [field.key]: event.target.value }))} />
                    )}
                  </label>
                ))}
                <small>Проверьте ID и регион. Корректный ID другого игрока тоже может принять пополнение, отменить такую доставку обычно невозможно.</small>
                {gameLoading ? <small className="gvoice-store-warning">Обновляем каталог и цены…</small> : null}
                {gameError ? <small className="gvoice-store-error">{gameError}</small> : null}
              </div>

              <div className="gvoice-store-summary">
                <small>РАСЧЁТ ЗАКАЗА</small>
                <h3>{gameCatalog?.brand ?? "Игровое пополнение"}</h3>
                <dl>
                  <div><dt>Игра</dt><dd>{gameCatalog?.category.name ?? "—"}</dd></div>
                  <div><dt>Регион</dt><dd>{gameCatalog?.category.region ?? "—"}</dd></div>
                  <div><dt>Пакет</dt><dd>{gameCatalog?.offers.find((offer) => offer.offerId === gameOfferId)?.name ?? "—"}</dd></div>
                  <div className="gvoice-store-total"><dt>К оплате</dt><dd>{formatRub(Number(gameCatalog?.offers.find((offer) => offer.offerId === gameOfferId)?.priceRub ?? 0))}</dd></div>
                </dl>
                <PaymentMethodPicker value={gamePaymentMethod} onChange={setGamePaymentMethod} />
                <small className="gvoice-store-payment-note">Поставщик получит заказ только после подтверждения оплаты Т‑Банком.</small>
                <label className="gvoice-store-legal-consent">
                  <input type="checkbox" checked={gameLegalAccepted} onChange={(event) => setGameLegalAccepted(event.target.checked)} />
                  <span>Проверил игру, регион и ID игрока, принимаю <button className="gvoice-store-document-link" type="button" onClick={() => onOpenLegal("games")}>условия игровых пополнений</button>.</span>
                </label>
                <button className="gvoice-store-primary" type="button" disabled={!config.gameTopups.enabled || !gameCatalog || !gameOfferId || !gameLegalAccepted || gameSubmitting} onClick={() => void startGamePayment()}>
                  {gameSubmitting ? "Создаём заказ…" : "Оплатить игровое пополнение"}
                </button>
                {!config.gameTopups.enabled ? <small className="gvoice-plus-launch-note">Каталог подключён в тестовом режиме. Оплата откроется после проверки товаров и разрешения Т‑Банка.</small> : null}
              </div>
            </div>
          </div>
        ) : null}

        {view === "games" && gameStage === "payment" && gameOrder ? (
          <div className="gvoice-store-test-payment">
            <div className="gvoice-store-payment-title">
              <small>БЕЗОПАСНАЯ ОПЛАТА Т‑БАНКА</small>
              <h3>{gameOrder.brand} · {gameOrder.offerName}</h3>
              <p>После оплаты заказ автоматически отправится поставщику.</p>
            </div>
            {gameOrder.paymentMethod === "card" && !nativePayment && config.terminalKey ? (
              <TBankPaymentFrame terminalKey={config.terminalKey} paymentUrl={gamePaymentUrl} orderId={gameOrder.id}
                onStatusChange={(status) => {
                  if (status === "SUCCESS") void checkGameOrder(true);
                  if (["CANCELED", "EXPIRED", "PROCESSING_ERROR", "REFUNDED", "REJECTED"].includes(status)) setGameError("Платёж не завершён.");
                }} onError={(message) => setGameError(message)} />
            ) : null}
            {gameOrder.paymentMethod === "sbp" ? (
              <div className="gvoice-store-sbp-payment">
                <span className="gvoice-store-sbp-mark">СБП</span>
                <div><b>Оплата через приложение банка</b><small>Откройте платёж, выберите свой банк и подтвердите перевод.</small></div>
                <a className="gvoice-store-payment-link" href={gamePaymentUrl} target="_blank" rel="noopener noreferrer">Перейти к оплате СБП</a>
              </div>
            ) : null}
            <div className="gvoice-store-order-summary">
              <span>Заказ: <b>{gameOrder.id}</b></span>
              <span>Игра: <b>{gameOrder.categoryName}</b></span>
              <span>Пакет: <b>{gameOrder.offerName}</b></span>
              <span>Способ: <b>{gameOrder.paymentMethod === "sbp" ? "СБП" : "Банковская карта"}</b></span>
              <span>К оплате: <b>{formatRub(Number(gameOrder.paymentAmount))}</b></span>
            </div>
            {gameError ? <small className="gvoice-store-error">{gameError}</small> : null}
            <footer>
              <button type="button" onClick={() => void checkGameOrder(true)} disabled={gameChecking}>{gameChecking ? "Проверяем…" : "Проверить статус"}</button>
              <a className="gvoice-store-payment-link" href={gamePaymentUrl} target="_blank" rel="noopener noreferrer">Открыть отдельно</a>
            </footer>
          </div>
        ) : null}

        {view === "games" && gameStage === "success" && gameOrder ? (
          <div className="gvoice-store-success">
            <span>{gameOrder.fulfillmentStatus === "completed" ? "✓" : ["failed", "refunded", "review_required"].includes(gameOrder.fulfillmentStatus) ? "!" : "…"}</span>
            <h3>{gameOrder.fulfillmentStatus === "completed" ? "Пополнение выполнено" : ["failed", "refunded", "review_required"].includes(gameOrder.fulfillmentStatus) ? "Заказ требует проверки" : "Пополнение выполняется"}</h3>
            <p>{gameOrder.fulfillmentStatus === "completed" ? `${gameOrder.offerName} доставлен на указанный игровой аккаунт.` : gameOrder.supplierStatusReason ?? "Оплата подтверждена, заказ проверяется поставщиком."}</p>
            {!isFinalFulfillment(gameOrder.fulfillmentStatus) ? <button type="button" onClick={() => void checkGameOrder(true)} disabled={gameChecking}>{gameChecking ? "Проверяем…" : "Обновить статус"}</button> : null}
            <button type="button" onClick={resetGame}>Новое пополнение</button>
          </div>
        ) : null}

        {view === "checkout" && stage === "form" ? (
          <div className="gvoice-store-content">
            <div className="gvoice-store-checkout-grid">
              <div className="gvoice-store-form-card">
                <label>
                  <b>Логин Steam</b>
                  <input value={steamLogin} onChange={(event) => setSteamLogin(event.target.value)} placeholder="Введите логин аккаунта" autoComplete="off" maxLength={64} />
                  <small>Внимательно проверьте логин: после передачи заказа поставщику изменить его нельзя.</small>
                </label>
                <label>
                  <b>Сколько зачислить в Steam</b>
                  <span className="gvoice-store-amount-input">
                    <input type="number" min={config.minSteamAmount} max={config.maxSteamAmount} step="1" value={steamAmount} onChange={(event) => setSteamAmount(event.target.value)} placeholder="500" />
                    <strong>RUB</strong>
                  </span>
                </label>
                <div className="gvoice-store-quick-amounts">
                  {QUICK_AMOUNTS.map((amount) => <button key={amount} type="button" onClick={() => setSteamAmount(String(amount))}>{amount.toLocaleString("ru-RU")} ₽</button>)}
                </div>
              </div>

              <div className="gvoice-store-summary">
                <small>РАСЧЁТ ЗАКАЗА</small>
                <h3>Пополнение Steam</h3>
                <dl>
                  <div><dt>В кошелёк Steam</dt><dd>{formatRub(price.amount)}</dd></div>
                  <div><dt>Сервисный сбор {config.markupPercent}%</dt><dd>{formatRub(price.markup)}</dd></div>
                  <div className="gvoice-store-total"><dt>К оплате</dt><dd>{formatRub(price.total)}</dd></div>
                </dl>
                <PaymentMethodPicker value={paymentMethod} onChange={setPaymentMethod} />
                <label className="gvoice-store-legal-consent">
                  <input type="checkbox" checked={legalAccepted} onChange={(event) => setLegalAccepted(event.target.checked)} />
                  <span>Подтверждаю правильность Steam-логина и принимаю <button className="gvoice-store-document-link" type="button" onClick={() => onOpenLegal("store")}>условия магазина</button> и <button className="gvoice-store-document-link" type="button" onClick={() => onOpenLegal("refund")}>правила возврата</button>.</span>
                </label>
                <button className="gvoice-store-primary" type="button" disabled={!canContinue || submitting} onClick={() => void startPayment()}>{submitting ? "Создаём заказ…" : "Оплатить в GVoice"}</button>
                {!config.configured ? (
                  <small className="gvoice-store-error">
                    {config.enabled === false
                      ? "Пополнение Steam временно приостановлено. История платежей остаётся доступной."
                      : "Оплата или автоматическое пополнение Steam ещё не настроены."}
                  </small>
                ) : null}
                {config.configured && !orderDataValid ? <small className="gvoice-store-warning">Укажите Steam-логин и сумму от {config.minSteamAmount.toLocaleString("ru-RU")} до {config.maxSteamAmount.toLocaleString("ru-RU")} ₽.</small> : null}
                {config.configured && orderDataValid && !legalAccepted ? <small className="gvoice-store-warning">Перед оплатой подтвердите согласие с условиями магазина и возврата.</small> : null}
                {error ? <small className="gvoice-store-error">{error}</small> : null}
              </div>
            </div>
          </div>
        ) : null}

        {view === "checkout" && stage === "payment" && order ? (
          <div className="gvoice-store-test-payment">
            <div className="gvoice-store-payment-title">
              <small>БЕЗОПАСНАЯ ОПЛАТА Т‑БАНКА</small>
              <h3>{nativePayment ? "Завершите оплату в защищённом окне" : "Оплата внутри GVoice"}</h3>
              <p>Статус заказа обновится автоматически после подтверждения банком.</p>
            </div>
            {order.paymentMethod === "card" && !nativePayment && config.terminalKey ? (
              <TBankPaymentFrame
                terminalKey={config.terminalKey}
                paymentUrl={paymentUrl}
                orderId={order.id}
                onStatusChange={(status) => {
                  if (status === "SUCCESS") void checkOrder(true);
                  if (["CANCELED", "EXPIRED", "PROCESSING_ERROR", "REFUNDED", "REJECTED"].includes(status)) {
                    setError("Платёж не завершён. Можно повторить попытку или открыть форму отдельно.");
                  }
                }}
                onError={(message) => setError(message)}
              />
            ) : null}
            {order.paymentMethod === "card" && !nativePayment && !config.terminalKey ? (
              <small className="gvoice-store-error">Публичный ключ терминала не получен. Используйте резервную кнопку ниже.</small>
            ) : null}
            {order.paymentMethod === "sbp" ? (
              <div className="gvoice-store-sbp-payment">
                <span className="gvoice-store-sbp-mark">СБП</span>
                <div><b>Оплата через приложение банка</b><small>Откройте платёж, выберите свой банк и подтвердите перевод.</small></div>
                <a className="gvoice-store-payment-link" href={paymentUrl} target="_blank" rel="noopener noreferrer">Перейти к оплате СБП</a>
              </div>
            ) : null}
            <div className="gvoice-store-order-summary">
              <span>Заказ: <b>{order.id}</b></span>
              <span>Steam: <b>{order.steamLogin}</b></span>
              <span>Зачисление: <b>{formatRub(Number(order.steamAmount))}</b></span>
              <span>Способ: <b>{order.paymentMethod === "sbp" ? "СБП" : "Банковская карта"}</b></span>
              <span>К оплате: <b>{formatRub(Number(order.paymentAmount))}</b></span>
            </div>
            {error ? <small className="gvoice-store-error">{error}</small> : null}
            <footer>
              <button type="button" onClick={() => void checkOrder(true)} disabled={checking}>{checking ? "Проверяем…" : "Проверить статус"}</button>
              <a className="gvoice-store-payment-link" href={paymentUrl} target="_blank" rel="noopener noreferrer">Открыть отдельно</a>
            </footer>
          </div>
        ) : null}

        {view === "checkout" && stage === "success" && order ? (
          <div className="gvoice-store-success">
            <span>{order.fulfillmentStatus === "completed" ? "✓" : order.fulfillmentStatus === "failed" || order.fulfillmentStatus === "refunded" || order.fulfillmentStatus === "review_required" ? "!" : "…"}</span>
            <h3>{order.fulfillmentStatus === "completed" ? "Steam пополнен" : order.fulfillmentStatus === "failed" || order.fulfillmentStatus === "refunded" || order.fulfillmentStatus === "review_required" ? "Нужна проверка заказа" : "Пополнение Steam выполняется"}</h3>
            <p>{order.fulfillmentStatus === "completed"
              ? `ReSellCodes подтвердил зачисление ${formatRub(Number(order.steamAmount))} на Steam-логин ${order.steamLogin}.`
              : order.fulfillmentStatus === "failed" || order.fulfillmentStatus === "refunded" || order.fulfillmentStatus === "review_required"
                ? `Автоматическое пополнение не завершено. ${order.supplierStatusReason ?? "Обратитесь в поддержку и сообщите номер заказа."}`
                : `Т-Банк подтвердил оплату. Заказ передан ReSellCodes и проверяется автоматически.`}</p>
            {!isFinalFulfillment(order.fulfillmentStatus) ? <button type="button" onClick={() => void checkOrder(true)} disabled={checking}>{checking ? "Проверяем…" : "Обновить статус"}</button> : null}
            <button type="button" onClick={reset}>Создать ещё один заказ</button>
          </div>
        ) : null}

        {view === "history" ? (
          <div className="gvoice-store-history">
            <div className="gvoice-store-history-heading">
              <div>
                <small>ВАШИ ОПЕРАЦИИ</small>
                <h3>История платежей</h3>
                <p>Здесь отображаются подписки и последние пополнения этого аккаунта.</p>
              </div>
              <button type="button" onClick={() => void loadHistory()} disabled={historyLoading}>{historyLoading ? "Обновляем…" : "Обновить"}</button>
            </div>

            {historyError ? <small className="gvoice-store-error">{historyError}</small> : null}
            {historyLoading && historyOrders.length === 0 && subscriptionOrders.length === 0 && gameHistoryOrders.length === 0 ? <div className="gvoice-store-history-empty">Загружаем историю…</div> : null}
            {!historyLoading && !historyError && historyOrders.length === 0 && subscriptionOrders.length === 0 && gameHistoryOrders.length === 0 ? (
              <div className="gvoice-store-history-empty">
                <b>Платежей пока нет</b>
                <span>После первой подписки или пополнения информация появится здесь.</span>
                <button type="button" onClick={() => setView("plus")}>Посмотреть GVoice+</button>
              </div>
            ) : null}

            {historyOrders.length > 0 || subscriptionOrders.length > 0 || gameHistoryOrders.length > 0 ? (
              <div className="gvoice-store-history-list">
                {subscriptionOrders.map((subscriptionOrder) => {
                  const paid = subscriptionOrder.status === "paid";
                  const failed = ["rejected", "canceled", "reversed", "deadline_expired", "payment_error"].includes(subscriptionOrder.status);
                  const canceling = subscriptionOrder.status === "cancel_pending";
                  const canContinue = subscriptionOrder.status === "pending"
                    && Boolean(subscriptionOrder.paymentUrl)
                    && Boolean(subscriptionOrder.expiresAt)
                    && new Date(subscriptionOrder.expiresAt!).getTime() > Date.now();
                  return (
                    <article key={subscriptionOrder.id} className="gvoice-store-history-item gvoice-store-history-plus">
                      <div className="gvoice-store-history-main">
                        <span className={`gvoice-store-status gvoice-store-status-${paid ? "success" : failed ? "error" : canceling ? "processing" : "pending"}`}>{paid ? "Активировано" : failed ? "Отменено" : canceling ? "Отменяется" : "Ожидает оплаты"}</span>
                        <time dateTime={subscriptionOrder.createdAt}>{formatOrderDate(subscriptionOrder.createdAt)}</time>
                        <h4>GVoice+ · {subscriptionOrder.billingPeriodDays} дней</h4>
                        <small>Заказ {subscriptionOrder.id}</small>
                        <small>Способ оплаты: {subscriptionOrder.paymentMethod === "sbp" ? "СБП" : "банковская карта"}</small>
                        {canContinue ? <small>Оплата доступна до {formatOrderDate(subscriptionOrder.expiresAt!)}</small> : null}
                      </div>
                      <div className="gvoice-store-history-side">
                        <dl><div><dt>Сумма</dt><dd>{formatRub(Number(subscriptionOrder.paymentAmount))}</dd></div></dl>
                        {canContinue ? (
                          <button type="button" onClick={() => {
                            setPlusOrder(subscriptionOrder);
                            setPlusPaymentUrl(subscriptionOrder.paymentUrl!);
                            setPlusPaymentMethod(subscriptionOrder.paymentMethod === "sbp" ? "sbp" : "card");
                            setPlusStage("payment");
                            setPlusError(null);
                            setView("plus");
                          }}>Продолжить оплату</button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
                {gameHistoryOrders.map((historyOrder) => {
                  const status = historyOrder.fulfillmentStatus === "completed"
                    ? { label: "Доставлено", tone: "success" }
                    : historyOrder.fulfillmentStatus === "refunded" || historyOrder.status === "refunded"
                      ? { label: "Возврат", tone: "warning" }
                      : ["failed", "review_required"].includes(historyOrder.fulfillmentStatus)
                        ? { label: "Нужна проверка", tone: "error" }
                        : ["rejected", "canceled", "reversed", "deadline_expired", "payment_error"].includes(historyOrder.status)
                          ? { label: "Оплата не прошла", tone: "error" }
                          : historyOrder.status === "paid"
                            ? { label: "В обработке", tone: "processing" }
                            : { label: "Ожидает оплаты", tone: "pending" };
                  return (
                    <article key={historyOrder.id} className="gvoice-store-history-item gvoice-store-history-game">
                      <div className="gvoice-store-history-main">
                        <span className={`gvoice-store-status gvoice-store-status-${status.tone}`}>{status.label}</span>
                        <time dateTime={historyOrder.createdAt}>{formatOrderDate(historyOrder.createdAt)}</time>
                        <h4>{historyOrder.brand} · {historyOrder.offerName}</h4>
                        <small>Заказ {historyOrder.id}</small>
                      </div>
                      <dl>
                        <div><dt>Регион</dt><dd>{historyOrder.region ?? "GLOBAL"}</dd></div>
                        <div><dt>Оплачено</dt><dd>{formatRub(Number(historyOrder.paymentAmount))}</dd></div>
                      </dl>
                      {historyOrder.supplierStatusReason ? <p>{historyOrder.supplierStatusReason}</p> : null}
                    </article>
                  );
                })}
                {historyOrders.map((historyOrder) => {
                  const status = orderStatus(historyOrder);
                  return (
                    <article key={historyOrder.id} className="gvoice-store-history-item">
                      <div className="gvoice-store-history-main">
                        <span className={`gvoice-store-status gvoice-store-status-${status.tone}`}>{status.label}</span>
                        <time dateTime={historyOrder.createdAt}>{formatOrderDate(historyOrder.createdAt)}</time>
                        <h4>Steam · {historyOrder.steamLogin}</h4>
                        <small>Заказ {historyOrder.id}</small>
                      </div>
                      <dl>
                        <div><dt>В Steam</dt><dd>{formatRub(Number(historyOrder.steamAmount))}</dd></div>
                        <div><dt>Комиссия</dt><dd>{formatRub(Number(historyOrder.serviceFee))}</dd></div>
                        <div><dt>Оплачено</dt><dd>{formatRub(Number(historyOrder.paymentAmount))}</dd></div>
                      </dl>
                      {historyOrder.supplierStatusReason ? <p>{historyOrder.supplierStatusReason}</p> : null}
                    </article>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
