import { useMutation } from "@tanstack/react-query";
import { ArrowRight, Check, Github, ShieldCheck, Sparkles } from "lucide-react";

import { api } from "../lib/api";

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const configuredProviders: string = import.meta.env.VITE_AUTH_PROVIDERS ?? "google";
const providers = new Set(
  configuredProviders
    .split(",")
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean),
);

function safeReturnUrl(): string {
  const fallback = new URL("/library", window.location.origin);
  const requested = new URLSearchParams(window.location.search).get("returnTo");
  if (!requested) return fallback.toString();
  try {
    const parsed = new URL(requested, window.location.origin);
    return parsed.origin === window.location.origin ? parsed.toString() : fallback.toString();
  } catch {
    return fallback.toString();
  }
}

export function LoginPage() {
  const returnUrl = safeReturnUrl();
  const devLogin = useMutation({
    mutationFn: api.devLogin,
    onSuccess: () => window.location.assign(returnUrl),
  });

  return (
    <main className="login-page">
      <section className="login-story">
        <div>
          <a className="brand login-brand" href="/">
            <span className="brand-mark">C</span>
            <span className="brand-word">Citera</span>
          </a>
          <p className="eyebrow light">YOUR RESEARCH, REMEMBERED</p>
          <h1>
            読む。残す。
            <br />
            知識をつなげる。
          </h1>
          <p className="login-lede">
            論文、PDF、ページメモをひとつに。Citera
            は研究の流れを止めず、どの端末にもあなたの文献庫を届けます。
          </p>
        </div>
        <ul className="feature-list">
          <li>
            <Check size={17} /> PDF と書誌情報を安全に同期
          </li>
          <li>
            <Check size={17} /> DOI・arXiv から自動取得
          </li>
          <li>
            <Check size={17} /> オフラインでも閲覧・メモ
          </li>
        </ul>
        <p className="login-quote">
          “A personal library should feel less like storage, and more like memory.”
        </p>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <span className="login-icon">
            <Sparkles size={22} />
          </span>
          <p className="eyebrow">WELCOME TO CITERA</p>
          <h2>あなたのライブラリへ</h2>
          <p>信頼できるアカウントでログインしてください。</p>
          <div className="login-actions">
            {providers.has("github") && (
              <a
                className="button oauth-button github"
                href={`${apiBase}/v1/auth/login/github?returnTo=${encodeURIComponent(returnUrl)}`}
              >
                <Github size={19} /> GitHub で続ける <ArrowRight size={17} />
              </a>
            )}
            {providers.has("google") && (
              <a
                className="button oauth-button google"
                href={`${apiBase}/v1/auth/login/google?returnTo=${encodeURIComponent(returnUrl)}`}
              >
                <span className="google-g" aria-hidden="true">
                  G
                </span>{" "}
                Google で続ける <ArrowRight size={17} />
              </a>
            )}
            {import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEV_LOGIN !== "false" && (
              <button
                className="text-button"
                onClick={() => devLogin.mutate()}
                disabled={devLogin.isPending}
              >
                {devLogin.isPending ? "準備中…" : "ローカル開発用アカウントで続ける"}
              </button>
            )}
          </div>
          {devLogin.error && (
            <p className="form-error" role="alert">
              ローカルログインに失敗しました。API の設定を確認してください。
            </p>
          )}
          <div className="security-note">
            <ShieldCheck size={17} />
            <span>
              セッションは安全な Cookie で保護されます。Citera
              がプロバイダのパスワードを保存することはありません。
            </span>
          </div>
        </div>
        <p className="login-footer">
          ログインすると、利用規約とプライバシーポリシーに同意したものとみなされます。
        </p>
      </section>
    </main>
  );
}
