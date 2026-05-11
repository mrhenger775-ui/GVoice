import { useState } from "react";
import { useAuth } from "../auth/AuthContext";

type Mode = "login" | "register";

export function AuthScreen() {
  const { login, requestRegisterCode, confirmRegisterCode, error } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [registerStep, setRegisterStep] = useState<"credentials" | "confirm">("credentials");
  const [submitting, setSubmitting] = useState(false);

  const isRegister = mode === "register";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);

    try {
      if (isRegister) {
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
      <p style={{ marginTop: 0, color: "#94a3b8" }}>Вход и регистрация MVP.</p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          onClick={() => {
            setMode("login");
            setRegisterStep("credentials");
            setVerificationCode("");
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
            setVerificationCode("");
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

        {isRegister && registerStep === "credentials" ? (
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

        {!isRegister || registerStep === "credentials" ? (
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

        {isRegister && registerStep === "confirm" ? (
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
            : isRegister
              ? registerStep === "credentials"
                ? "Получить код на email"
                : "Завершить регистрацию"
              : "Войти"}
        </button>

        {isRegister && registerStep === "confirm" ? (
          <button
            type="button"
            onClick={() => setRegisterStep("credentials")}
            style={{ background: "#0f172a", color: "#e5e7eb", border: "1px solid #334155", borderRadius: 6 }}
          >
            Изменить email/логин
          </button>
        ) : null}
      </form>

      {error ? <p style={{ color: "#c21" }}>{error}</p> : null}
    </main>
  );
}
