import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"] || "5000";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ── 24/7 Stability: Global error handlers ────────────────────────────────────
// Ye ensure karta hai ke unhandled errors server ko crash na karein.
// Pollers already try/catch/finally use karte hain, lekin koi bhi unforeseen
// async error yahan catch ho jayega.
process.on("uncaughtException", (err) => {
  logger.error({ err }, "[CRASH] Uncaught exception — server continue kar raha hai");
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error({ reason, promise }, "[CRASH] Unhandled promise rejection — server continue kar raha hai");
});
// ─────────────────────────────────────────────────────────────────────────────

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
