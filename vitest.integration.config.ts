import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./workers/api/src/index.ts",
      miniflare: {
        compatibilityDate: "2026-07-13",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ENVIRONMENT: "test",
          APP_ORIGIN: "https://citera.test",
          ALLOWED_ORIGINS: "https://citera.test",
          ALLOWED_EXTENSION_IDS: "integration-extension-id",
          AUTH_DEV_BYPASS: "true",
          TOKEN_HASH_PEPPER: "integration-token-hash-pepper-change-me",
          IP_HASH_SALT: "integration-ip-hash-salt-change-me",
          R2_BUCKET_NAME: "citera-integration-files",
          MAX_PDF_BYTES: String(10 * 1024 * 1024),
          PRESIGN_TTL_SECONDS: "300",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
        d1Databases: ["DB"],
        r2Buckets: ["FILES"],
        queueProducers: { JOBS: "citera-integration-jobs" },
      },
    })),
  ],
  test: {
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
    testTimeout: 15_000,
  },
});
