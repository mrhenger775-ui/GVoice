import { useAuth } from "./auth/AuthContext";
import { AuthScreen } from "./components/AuthScreen";
import { Dashboard } from "./components/Dashboard";

export function App() {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <main style={{ margin: "3rem", fontFamily: "Segoe UI, sans-serif", color: "#e5e7eb" }}>
        <p>Проверяю сессию...</p>
      </main>
    );
  }

  if (status === "anonymous") {
    return <AuthScreen />;
  }

  return <Dashboard />;
}
