type Level = "debug" | "info" | "warn" | "error";

const rank: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug: (method: string, message: string, ...rest: unknown[]) => void;
  info: (method: string, message: string, ...rest: unknown[]) => void;
  warn: (method: string, message: string, ...rest: unknown[]) => void;
  error: (method: string, message: string, ...rest: unknown[]) => void;
}

// The minimum level that prints, from LOG_LEVEL (default "info"). Resolved on
// every emit so tests can change it at runtime; an unknown value throws.
function threshold(): number {
  const raw = process.env.LOG_LEVEL;
  if (raw === undefined || raw.trim() === "") return rank.info;
  const value = levelRank(raw.trim().toLowerCase());
  if (value === undefined) {
    throw new Error(`[createLogger] LOG_LEVEL must be one of debug|info|warn|error, got "${raw}"`);
  }
  return value;
}

function levelRank(name: string): number | undefined {
  return name === "debug" || name === "info" || name === "warn" || name === "error" ? rank[name] : undefined;
}

export function createLogger(scope: string): Logger {
  if (typeof scope !== "string" || scope.trim() === "") {
    throw new Error("[createLogger] scope must be a non-empty string");
  }
  const emit = (level: Level, method: string, message: string, rest: unknown[]): void => {
    if (rank[level] < threshold()) return;
    const prefix = level === "warn" ? "[WARNING] " : "";
    console[level](`${new Date().toISOString()} ${prefix}[${scope}.${method}] ${message}`, ...rest);
  };
  return {
    debug: (method, message, ...rest) => emit("debug", method, message, rest),
    info: (method, message, ...rest) => emit("info", method, message, rest),
    warn: (method, message, ...rest) => emit("warn", method, message, rest),
    error: (method, message, ...rest) => emit("error", method, message, rest),
  };
}
