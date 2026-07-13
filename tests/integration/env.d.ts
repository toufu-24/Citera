import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as ApiEnv } from "../../workers/api/src/types";

declare global {
  namespace Cloudflare {
    interface Env extends ApiEnv {
      TEST_MIGRATIONS: D1Migration[];
    }

    interface Exports {
      default: typeof import("../../workers/api/src/index").default;
    }
  }
}

export {};
