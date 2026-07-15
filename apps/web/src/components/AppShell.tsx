import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { Cloud, LogOut, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

import { api, ApiRequestError } from "../lib/api";
import { clearActiveDatabase } from "../lib/database";
import { installSyncTriggers, type SyncStatus } from "../lib/sync";

export function AppShell() {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(
    navigator.onLine ? "syncing" : "offline",
  );
  const [loggingOut, setLoggingOut] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: api.session,
    retry: false,
  });

  useEffect(() => {
    if (session.error instanceof ApiRequestError && session.error.status === 401) {
      void navigate({ to: "/login", search: { returnTo: location.href } });
    }
  }, [location.href, navigate, session.error]);

  useEffect(() => installSyncTriggers(setSyncStatus), []);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    const accessSession = session.data?.session?.authenticationMethod === "access";
    try {
      await api.logout();
    } catch (error) {
      console.warn(
        "The remote session could not be revoked; local Citera data was cleared.",
        error,
      );
    } finally {
      queryClient.clear();
      try {
        await clearActiveDatabase();
      } catch (error) {
        console.warn("The local Citera database could not be cleared during logout.", error);
      }
      if (accessSession) {
        window.location.replace("/cdn-cgi/access/logout");
      } else {
        window.location.replace("/login");
      }
    }
  }

  return (
    <div className="app-shell">
      <main className="app-content">
        <header className="app-header">
          <Link to="/library" className="brand" aria-label="Citera ホーム">
            <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
            <span className="brand-word">Citera</span>
          </Link>
          <div className="app-header-actions">
            <div className={`sync-status is-${syncStatus}`} aria-label="同期状態">
              {syncStatus === "offline" ? <WifiOff size={16} /> : <Cloud size={16} />}
              <span>
                {syncStatus === "syncing"
                  ? "同期中"
                  : syncStatus === "synced"
                    ? "同期済み"
                    : syncStatus === "error"
                      ? "同期に失敗"
                      : "オフライン"}
              </span>
              {syncStatus === "synced" && <span className="status-dot" />}
            </div>
            <Link to="/settings" className="account-trigger" aria-label="アカウント設定を開く">
              <span className="avatar small">
                {session.data?.user.displayName.slice(0, 1).toUpperCase() ?? "C"}
              </span>
              <span className="account-copy">
                <strong>{session.data?.user.displayName ?? "読み込み中"}</strong>
                <span>{session.data?.user.email ?? ""}</span>
              </span>
            </Link>
            <button
              type="button"
              className="icon-button header-logout"
              onClick={() => void logout()}
              disabled={loggingOut}
              aria-busy={loggingOut}
              aria-label="ログアウト"
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>
        <Outlet />
      </main>
    </div>
  );
}
