type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogContext = Record<string, unknown> & {
  correlationId?: string;
  clientId?: string;
  taskId?: string;
  userId?: string;
};

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[resolveLevel()];
}

function emit(
  level: LogLevel,
  message: string,
  context?: LogContext,
): void {
  if (!shouldLog(level)) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    correlationId: context?.correlationId,
    ...context,
  };

  // Never allow callers to accidentally dump secrets via known keys.
  const scrubbed = scrubSecrets(entry);
  const line = JSON.stringify(scrubbed);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

const SECRET_KEYS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "password",
  "authorization",
  "encrypted_access_token",
  "encrypted_refresh_token",
  "code_verifier",
  "client_secret",
]);

function scrubSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k.toLowerCase()) || k.toLowerCase().includes("token")) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = scrubSecrets(v);
      }
    }
    return out;
  }
  return value;
}

export function createLogger(base?: LogContext) {
  return {
    child(extra: LogContext) {
      return createLogger({ ...base, ...extra });
    },
    debug(message: string, context?: LogContext) {
      emit("debug", message, { ...base, ...context });
    },
    info(message: string, context?: LogContext) {
      emit("info", message, { ...base, ...context });
    },
    warn(message: string, context?: LogContext) {
      emit("warn", message, { ...base, ...context });
    },
    error(message: string, context?: LogContext) {
      emit("error", message, { ...base, ...context });
    },
  };
}

export const logger = createLogger();

export function newCorrelationId(): string {
  return `corr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
