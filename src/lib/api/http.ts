import { NextResponse } from "next/server";
import { z, ZodError } from "zod";

type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    /**
     * Extra response headers to send with this error.
     *
     * Used for headers that are part of the HTTP contract rather than the body —
     * notably `Retry-After` on a 423/429, which well-behaved clients and proxies
     * honour automatically.
     */
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export function json<T>(data: T, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export function empty(status = 204) {
  return new NextResponse(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function parseJson<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }

  const result = schema.safeParse(body);

  if (!result.success) {
    throw new ApiError(
      422,
      "validation_failed",
      "Request body failed validation.",
      result.error.flatten(),
    );
  }

  return result.data;
}

export function handleApiError(error: unknown) {
  if (error instanceof ApiError) {
    return errorResponse(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
      error.status,
      error.headers,
    );
  }

  if (error instanceof ZodError) {
    return errorResponse(
      {
        error: {
          code: "validation_failed",
          message: "Request body failed validation.",
          details: error.flatten(),
        },
      },
      422,
    );
  }

  if (isDatabaseUnavailableError(error)) {
    return errorResponse(
      {
        error: {
          code: "database_unavailable",
          message:
            "Database connection failed. Start PostgreSQL (or Docker DB) and try again.",
        },
      },
      503,
    );
  }

  console.error(error);

  return errorResponse(
    {
      error: {
        code: "internal_error",
        message: "An unexpected server error occurred.",
      },
    },
    500,
  );
}

function isDatabaseUnavailableError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as { code?: unknown; message?: unknown };
  const code = typeof record.code === "string" ? record.code : "";
  const message = typeof record.message === "string" ? record.message : "";

  // Prisma DB connectivity failures surface as either generic network errors
  // (for adapters) or Prisma codes like P1001/P1017.
  return (
    code === "ECONNREFUSED" ||
    code === "P1001" ||
    code === "P1017" ||
    message.includes("Can't reach database server")
  );
}

function errorResponse(
  body: ErrorBody,
  status: number,
  extraHeaders?: Record<string, string>,
) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}
