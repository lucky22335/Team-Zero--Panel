import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// API routes
app.use("/api", router);

// Always serve compiled React panel as static files
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// From dist/index.mjs → ../../team-zero-panel/dist/public
const panelDist = path.resolve(__dirname, "..", "..", "team-zero-panel", "dist", "public");

app.use(express.static(panelDist));

// SPA fallback — serve index.html for any non-API route
// Express 5 requires named wildcard params — "/*path" instead of "*"
app.get("/{*path}", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(panelDist, "index.html"));
});

export default app;
