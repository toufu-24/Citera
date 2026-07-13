import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { router } from "./router";
import "./styles/global.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: (count) => count < 1 && navigator.onLine },
    mutations: { retry: false },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Citera root element was not found");

// Older Citera builds cached authenticated API responses without a user namespace.
// Dexie is the only offline data source now, so remove that legacy cache on every boot.
if ("caches" in window) void window.caches.delete("citera-api");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>
  </StrictMode>,
);
