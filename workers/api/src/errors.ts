import type { Context } from "hono";
import { ZodError } from "zod";
import type { AppBindings } from "./types";

export class ApiError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 428 | 429 | 500 | 502 | 503;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: ApiError["status"],
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorResponse(c: Context<AppBindings>, error: unknown): Response {
  const requestId = c.get("requestId") ?? "req_unknown";
  if (error instanceof ApiError) {
    return c.json(
      { error: { code: error.code, message: error.message, details: error.details }, requestId },
      error.status,
    );
  }
  if (error instanceof ZodError) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "The request is invalid.",
          details: { issues: error.issues },
        },
        requestId,
      },
      422,
    );
  }
  console.error("Unhandled API error", {
    requestId,
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : "Unknown error",
  });
  return c.json(
    {
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred.", details: {} },
      requestId,
    },
    500,
  );
}
