import { useEffect, useState } from "react";
import { AuthScreen } from "./AuthScreen";
import { LegalPage } from "./LegalPage";
import { PublicSupportPage } from "./PublicSupportPage";
import "./LandingPage.css";

const DOWNLOAD_URL =
  import.meta.env.VITE_DESKTOP_DOWNLOAD_URL ??
  "https://github.com/mrhenger775-ui/GVoice/releases/latest/download/GVoice-Setup-0.1.8.exe";

const features = [
  {
    icon: "◉",
    title: "Голосовые каналы",
    text: "Общайся с друзьями в пространствах или созванивайся один на один."
  },
  {
    icon: "▣",
    title: "Демонстрация экрана",
    text: "Показывай весь экран или отдельное окно прямо во время разговора."
  },
  {
    icon: "⌁",
    title: "Чаты и уведомления",
    text: "Пиши в каналах и личных сообщениях, не пропуская новые события."
  },
  {
    icon: "✦",
    title: "Мини-игры",
    text: "Запускай GStrike в голосовом канале и играй, пока остальные наблюдают."
  }
];

const steps = [
  ["01", "Создай аккаунт", "Зарегистрируйся по email и подтверди его кодом."],
  ["02", "Найди своих", "Добавь друзей или вступи в подходящее пространство."],
  ["03", "Начни общение", "Подключись к голосовому каналу, чату или личному звонку."]
];

export function LandingPage() {
  const [authOpen, setAuthOpen] = useState(false);
  const [page, setPage] = useState<"home" | "legal" | "support">(() => window.location.hash === "#legal" ? "legal" : window.location.hash === "#support" ? "support" : "home");
  useEffect(() => { const sync = () => setPage(window.location.hash === "#legal" ? "legal" : window.location.hash === "#support" ? "support" : "home"); window.addEventListener("hashchange", sync); return () => window.removeEventListener("hashchange", sync); }, []);

  function openAuth() {
    setPage("home");
    window.location.hash = "top";
    setAuthOpen(true);
    window.setTimeout(() => {
      document.getElementById("gvoice-auth")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
  }

  if (page === "legal") return <LegalPage onBack={() => { window.location.hash = "top"; setPage("home"); }} />;
  if (page === "support") return <PublicSupportPage onBack={() => { window.location.hash = "top"; setPage("home"); }} onLogin={openAuth} />;

  return (
    <main className="landing-page">
      <div className="landing-glow landing-glow-one" />
      <div className="landing-glow landing-glow-two" />

      <header className="landing-header">
        <a className="landing-brand" href="#top" aria-label="GVoice — на главную">
          <img src="/ui/gvoice-logo-main.png" alt="GVoice" />
        </a>
        <nav className="landing-nav" aria-label="Навигация">
          <a href="#features">Возможности</a>
          <a href="#start">Как начать</a>
          <a href="#download">Приложение</a>
          <a href="#support">Поддержка</a>
          <a href="#legal">Условия использования</a>
        </nav>
        <button className="landing-button landing-button-ghost" type="button" onClick={openAuth}>
          Войти
        </button>
      </header>

      <section className="landing-hero" id="top">
        <div className="landing-hero-copy">
          <div className="landing-eyebrow"><span /> ТВОЁ ПРОСТРАНСТВО ДЛЯ ОБЩЕНИЯ</div>
          <h1>Будь на связи.<br /><em>Играй. Общайся.</em></h1>
          <p>
            GVoice объединяет голосовые каналы, личные сообщения, демонстрацию экрана
            и мини-игры в одном удобном месте.
          </p>
          <div className="landing-actions">
            <a className="landing-button landing-button-primary" href={DOWNLOAD_URL} download>
              <span className="landing-windows-icon">⊞</span>
              Скачать для Windows
            </a>
            <button className="landing-button landing-button-secondary" type="button" onClick={openAuth}>
              Открыть в браузере
            </button>
          </div>
          <div className="landing-meta">
            <span><b>✓</b> Бесплатно</span>
            <span><b>✓</b> Windows 10/11</span>
            <span><b>✓</b> Есть веб-версия</span>
          </div>
        </div>

        <div className="landing-preview" aria-label="Предпросмотр GVoice">
          <img
            className="landing-preview-image"
            src="/ui/landing-gvoice-preview.svg"
            alt="Интерфейс GVoice с голосовым каналом и тремя участниками"
            draggable={false}
          />
          <img
            className="landing-preview-logo"
            src="/ui/gvoice-logo-main.png"
            alt=""
            draggable={false}
          />
        </div>
      </section>

      <section className="landing-section" id="features">
        <div className="landing-section-heading">
          <span>ВОЗМОЖНОСТИ</span>
          <h2>Всё необходимое — <em>в одном месте</em></h2>
          <p>Никаких лишних переключений. GVoice помогает оставаться рядом.</p>
        </div>
        <div className="landing-features">
          {features.map((feature) => (
            <article key={feature.title}>
              <div>{feature.icon}</div>
              <h3>{feature.title}</h3>
              <p>{feature.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-section landing-start" id="start">
        <div className="landing-section-heading">
          <span>БЫСТРЫЙ СТАРТ</span>
          <h2>Начни общаться за <em>пару минут</em></h2>
        </div>
        <div className="landing-steps">
          {steps.map(([number, title, text], index) => (
            <article key={number}>
              <div className="landing-step-number">{number}</div>
              {index < steps.length - 1 ? <div className="landing-step-line" /> : null}
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-download" id="download">
        <div>
          <span className="landing-download-icon">⊞</span>
          <div>
            <small>ПРИЛОЖЕНИЕ ДЛЯ WINDOWS</small>
            <h2>GVoice всегда под рукой</h2>
            <p>Глобальные горячие клавиши, удобная демонстрация экрана и автоматические обновления.</p>
          </div>
        </div>
        <a className="landing-button landing-button-primary" href={DOWNLOAD_URL} download>
          Скачать приложение
        </a>
      </section>

      {authOpen ? (
        <section className="landing-auth-section" id="gvoice-auth">
          <button className="landing-auth-close" type="button" onClick={() => setAuthOpen(false)} aria-label="Закрыть форму">×</button>
          <div className="landing-section-heading">
            <span>ВЕБ-ВЕРСИЯ</span>
            <h2>Войди в <em>GVoice</em></h2>
          </div>
          <AuthScreen />
        </section>
      ) : null}

      <footer className="landing-footer">
        <img src="/ui/gvoice-logo-main.png" alt="GVoice" />
        <p>Общение, которое всегда рядом.</p>
        <a
          className="landing-payment-partner"
          href="https://freekassa.net"
          title="small_5"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Оплата через FreeKassa"
        >
          <img
            src="https://cdn.freekassa.net/images/logos/banners/f/small_5.png"
            alt="Оплата через FreeKassa"
          />
        </a>
        <span><a href="#support">Поддержка</a> · <a href="#legal">Правовые документы</a> · © 2026 GVoice</span>
      </footer>
    </main>
  );
}
