import pino from "pino";

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info");

/**
 * Structured JSON logs (Railway ingests stdout as JSON and makes fields
 * searchable). Secrets are redacted by path wherever they could appear.
 */
export const logger = pino({
  level,
  base: { service: "ai-instagram-agent", role: process.env.ROLE ?? "all" },
  redact: {
    paths: [
      "access_token",
      "*.access_token",
      "*.accessToken",
      "accessToken",
      "token",
      "*.token",
      "headers.authorization",
      "*.headers.authorization",
      "apiKey",
      "*.apiKey",
    ],
    censor: "[redacted]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
