import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import {
  BookOpen,
  ChevronDown,
  Cloud,
  LogOut,
  PanelLeftClose,
  Search,
  Settings,
  WifiOff,
} from "lucide-react";
import { useEffect, useState } from "react";

import { api, ApiRequestError } from "../lib/api";
import { clearActiveDatabase } from "../lib/database";
import { installSyncTriggers } from "../lib/sync";

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
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

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => installSyncTriggers(), []);

  async function logout() {
    try {
      await api.logout();
    } catch (error) {
      console.warn(
        "The remote session could not be revoked; local Citera data was cleared.",
        error,
      );
    } finally {
      queryClient.clear();
      await clearActiveDatabase();
      void navigate({ to: "/login", search: { returnTo: undefined } });
    }
  }

  return (
    <div className={collapsed ? "app-shell is-collapsed" : "app-shell"}>
      <aside className="sidebar" aria-label="メインナビゲーション">
        <div className="brand-row">
          <Link to="/library" className="brand" aria-label="Citera ホーム">
            <span className="brand-mark" aria-hidden="true">
              C
            </span>
            <span className="brand-word">Citera</span>
          </Link>
          <button
            className="icon-button sidebar-collapse"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "サイドバーを開く" : "サイドバーを閉じる"}
          >
            <PanelLeftClose size={18} />
          </button>
        </div>

        <nav className="sidebar-nav">
          <Link to="/library" activeProps={{ className: "active" }}>
            <BookOpen size={19} />
            <span>ライブラリ</span>
          </Link>
          <a href="/library?focus=search">
            <Search size={19} />
            <span>高度な検索</span>
          </a>
          <Link to="/settings" activeProps={{ className: "active" }}>
            <Settings size={19} />
            <span>設定</span>
          </Link>
        </nav>

        <div className="sidebar-spacer" />
        <div className={online ? "sync-status" : "sync-status is-offline"}>
          {online ? <Cloud size={16} /> : <WifiOff size={16} />}
          <span>{online ? "同期中" : "オフライン"}</span>
          {online && <span className="status-dot" />}
        </div>
        <div className="account-card">
          <div className="avatar">
            {session.data?.user.displayName.slice(0, 1).toUpperCase() ?? "C"}
          </div>
          <div className="account-copy">
            <strong>{session.data?.user.displayName ?? "読み込み中"}</strong>
            <span>{session.data?.user.email ?? ""}</span>
          </div>
          <button className="icon-button" onClick={() => void logout()} aria-label="ログアウト">
            <LogOut size={17} />
          </button>
        </div>
      </aside>

      <main className="app-content">
        <header className="mobile-header">
          <Link to="/library" className="brand">
            <span className="brand-mark">C</span>
            <span className="brand-word">Citera</span>
          </Link>
          <Link to="/settings" className="account-trigger" aria-label="設定を開く">
            <span className="avatar small">
              {session.data?.user.displayName.slice(0, 1) ?? "C"}
            </span>
            <ChevronDown size={16} />
          </Link>
        </header>
        <Outlet />
      </main>
    </div>
  );
}
