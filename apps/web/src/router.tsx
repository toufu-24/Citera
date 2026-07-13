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

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
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
