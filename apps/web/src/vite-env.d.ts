/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_AUTH_PROVIDERS?: string;
  readonly VITE_ENABLE_DEV_LOGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
