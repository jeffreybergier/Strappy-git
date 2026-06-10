type Level = "info" | "warn" | "error";

export interface Logger {
  info: (method: string, message: string, ...rest: unknown[]) => void;
  warn: (method: string, message: string, ...rest: unknown[]) => void;
  error: (method: string, message: string, ...rest: unknown[]) => void;
}

export function createLogger(scope: string): Logger {
  if (typeof scope !== "string" || scope.trim() === "") {
    throw new Error("[createLogger] scope must be a non-empty string");
  }
  const emit = (level: Level, method: string, message: string, rest: unknown[]): void => {
    const prefix = level === "warn" ? "[WARNING] " : "";
    console[level](`${prefix}[${scope}.${method}] ${message}`, ...rest);
  };
  return {
    info: (method, message, ...rest) => emit("info", method, message, rest),
    warn: (method, message, ...rest) => emit("warn", method, message, rest),
    error: (method, message, ...rest) => emit("error", method, message, rest),
  };
}
