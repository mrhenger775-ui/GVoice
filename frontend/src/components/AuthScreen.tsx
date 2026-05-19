import { useState } from "react";
import { useAuth } from "../auth/AuthContext";

type Mode = "login" | "register";
type RecoveryStep = "none" | "request" | "confirm";

export function AuthScreen() {
  const { login, requestRegisterCode, confirmRegisterCode, requestPasswordResetCode, confirmPasswordReset, error } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [registerStep, setRegisterStep] = useState<"credentials" | "confirm">("credentials");
  const [recoveryStep, setRecoveryStep] = useState<RecoveryStep>("none");
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isRegister = mode === "register";
  const isRecovery = recoveryStep !== "none";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setNotice(null);

    try {
      if (isRecovery) {
        if (recoveryStep === "request") {
          await requestPasswordResetCode({ email });
          setRecoveryStep("confirm");
          setNotice("Код отправлен на email. Введите его и новый пароль.");
        } else {
          await confirmPasswordReset({ email, code: verificationCode, newPassword });
          setRecoveryStep("none");
          setVerificationCode("");
          setNewPassword("");
          setPassword("");
          setMode("login");
          setNotice("Пароль успешно изменен. Теперь войдите с новым паролем.");
        }
      } else if (isRegister) {
        if (registerStep === "credentials") {
          await requestRegisterCode({ email, username, password });
          setRegisterStep("confirm");
        } else {
          await confirmRegisterCode({ email, code: verificationCode });
        }
      } else {
        await login({ email, password });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      style={{
        maxWidth: 420,
        width: "calc(100% - 1rem)",
        margin: "1rem auto",
        fontFamily: "Segoe UI, sans-serif",
        color: "#e5e7eb",
        background: "#0b1020",
        border: "1px solid #1f2937",
        borderRadius: 12,
        padding: "0.875rem"
      }}
    >
      <h1 style={{ marginBottom: 8 }}>GVoice</h1>
      <p style={{ marginTop: 0, color: "#94a3b8" }}>Вход и регистрация.</p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          onClick={() => {
            setMode("login");
            setRegisterStep("credentials");
            setRecoveryStep("none");
            setVerificationCode("");
            setNotice(null);
          }}
          disabled={mode === "login"}
        >
          Вход
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("register");
            setRegisterStep("credentials");
            setRecoveryStep("none");
            setVerificationCode("");
            setNotice(null);
          }}
          disabled={mode === "register"}
        >
          Регистрация
        </button>
      </div>

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 10 }}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          style={{ background: "#0f172a", color: "#e5e7eb", border: "1px solid #334155", borderRadius: 6 }}
        />

        {isRegister && !isRecovery && registerStep === "credentials" ? (
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            minLength={3}
            required
            style={{ background: "#0f172a", color: "#e5e7eb", border: "1px solid #334155", borderRadius: 6 }}
          />
        ) : null}

        {!isRecovery && (!isRegister || registerStep === "credentials") ? (
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={8}
            required
            style={{ background: "#0f172a", color: "#e5e7eb", border: "1px solid #334155", borderRadius: 6 }}
          />
        ) : null}

        {isRecovery && recoveryStep === "confirm" ? (
          <input
            type="password"
            placeholder="Новый пароль"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            minLength={8}
            required
            style={{ background: "#0f172a", color: "#e5e7eb", border: "1px solid #334155", borderRadius: 6 }}
          />
        ) : null}

        {(isRegister && !isRecovery && registerStep === "confirm") || (isRecovery && recoveryStep === "confirm") ? (
          <input
            type="text"
            placeholder="Код из email"
            value={verificationCode}
            onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
            minLength={4}
            maxLength={8}
            required
            style={{ background: "#0f172a", color: "#e5e7eb", border: "1px solid #334155", borderRadius: 6 }}
          />
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          style={{ background: "#0f172a", color: "#e5e7eb", border: "1px solid #334155", borderRadius: 6 }}
        >
          {submitting
            ? "Подождите..."
            : isRecovery
              ? recoveryStep === "request"
                ? "Получить код для сброса"
                : "Сменить пароль"
              : isRegister
                ? registerStep === "credentials"
                  ? "Получить код на email"
                  : "Завершить регистрацию"
                : "Войти"}
        </button>

        {!isRecovery && !isRegister ? (
          <button
            type="button"
            onClick={() => {
              setRecoveryStep("request");
              setVerificationCode("");
              setNewPassword("");
              setNotice(null);
            }}
            style={{ background: "#0f172a", color: "#93c5fd", border: "1px solid #334155", borderRadius: 6 }}
          >
            Забыли пароль?
          </button>
        ) : null}

        {isRecovery ? (
          <button
            type="button"
            onClick={() => {
              setRecoveryStep("none");
              setVerificationCode("");
              setNewPassword("");
              setNotice(null);
            }}
            style={{ background: "#0f172a", color: "#e5e7eb", border: "1px solid #334155", borderRadius: 6 }}
          >
            Назад ко входу
          </button>
        ) : null}

        {isRegister && !isRecovery && registerStep === "confirm" ? (
          <button
            type="button"
            onClick={() => setRegisterStep("credentials")}
            style={{ background: "#0f172a", color: "#e5e7eb", border: "1px solid #334155", borderRadius: 6 }}
          >
            Изменить email/логин
          </button>
        ) : null}
      </form>

      {notice ? <p style={{ color: "#4ade80" }}>{notice}</p> : null}
      {error ? <p style={{ color: "#c21" }}>{error}</p> : null}
    </main>
  );
}
