import { useAuth } from "./auth/AuthContext";
import { AuthScreen } from "./components/AuthScreen";
import { Dashboard } from "./components/Dashboard";

export function App() {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <main
        style={{
          position: "fixed",
          inset: 0,
          background: "#020617",
          display: "grid",
          placeItems: "center",
          overflow: "hidden"
        }}
      >
        <video
          autoPlay
          muted
          loop
          playsInline
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        >
          <source src="/ui/runway-loading.mp4" type="video/mp4" />
        </video>
        <div
          style={{
            position: "absolute",
            bottom: 18,
            left: 0,
            right: 0,
            textAlign: "center",
            color: "#cbd5e1",
            fontFamily: "Segoe UI, sans-serif",
            fontSize: 13,
            textShadow: "0 1px 2px rgba(0,0,0,0.6)"
          }}
        >
          Проверяю сессию...
        </div>
      </main>
    );
  }

  if (status === "anonymous") {
    return <AuthScreen />;
  }

  return <Dashboard />;
}
