import type { QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";

import { api, ApiRequestError } from "./lib/api";
import { activateDatabaseForUser } from "./lib/database";

function RootError({ error, reset }: { error: Error; reset: () => void }) {
  const isOffline = !navigator.onLine;
  return (
    <main className="standalone-message route-error">
      <img className="brand-mark" src="/favicon.svg" alt="" />
      <p className="eyebrow">{isOffline ? "OFFLINE" : "CONNECTION ERROR"}</p>
      <h1>{isOffline ? "現在オフラインです" : "Citeraを開けませんでした"}</h1>
      <p>
        {isOffline
          ? "ネットワークに再接続してから、もう一度お試しください。"
          : "一時的な接続エラーが発生しました。データが失われることはありません。"}
      </p>
      {import.meta.env.DEV && <small>{error.message}</small>}
      <div className="route-error-actions">
        <button className="button primary" type="button" onClick={reset}>
          もう一度試す
        </button>
        <a className="button secondary" href="/login">
          ログイン画面へ
        </a>
      </div>
    </main>
  );
}

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  errorComponent: RootError,
  notFoundComponent: () => (
    <main className="standalone-message">
      <p className="eyebrow">404</p>
      <h1>そのページは見つかりませんでした。</h1>
      <a href="/library">ライブラリへ戻る</a>
    </main>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    // TanStack Router models redirects as control-flow values rather than Error instances.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: "/library" });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>) => ({
    returnTo: typeof search.returnTo === "string" ? search.returnTo : undefined,
  }),
  component: lazyRouteComponent(() => import("./routes/LoginPage"), "LoginPage"),
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async ({ context, location }) => {
    if (!navigator.onLine) return;
    try {
      const session = await context.queryClient.ensureQueryData({
        queryKey: ["session"],
        queryFn: api.session,
        staleTime: 30_000,
      });
      if (await activateDatabaseForUser(session.user.id)) {
        context.queryClient.clear();
        context.queryClient.setQueryData(["session"], session);
      }
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        // TanStack Router models redirects as control-flow values rather than Error instances.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw redirect({ to: "/login", search: { returnTo: location.href } });
      }
      // A temporary API outage must not block access to the user-scoped offline store.
      // Screen-level queries surface a recoverable error when no cached data exists.
      if (error instanceof TypeError || (error instanceof ApiRequestError && error.status >= 500)) {
        return;
      }
      throw error;
    }
  },
  component: lazyRouteComponent(() => import("./components/AppShell"), "AppShell"),
});

const libraryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/library",
  component: lazyRouteComponent(() => import("./routes/LibraryPage"), "LibraryPage"),
});

const paperRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/papers/$paperId",
  component: lazyRouteComponent(() => import("./routes/PaperDetailPage"), "PaperDetailPage"),
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: lazyRouteComponent(() => import("./routes/SettingsPage"), "SettingsPage"),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  appRoute.addChildren([libraryRoute, paperRoute, settingsRoute]),
]);

export const router = createRouter({ routeTree, context: { queryClient: undefined! } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
