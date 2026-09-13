import express from "express";
import mongoose from "mongoose";
import morgan from "morgan";
import bodyParser from "body-parser";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import hpp from "hpp";
import session from "express-session";

/**
 * ============ AUDIT LOG — THIS IMPORT MUST STAY FIRST ============
 *
 * services/auditLog.js calls `mongoose.plugin()` at module scope, and a global
 * plugin only reaches schemas compiled AFTER that call. ESM evaluates import
 * declarations in TEXTUAL order, so being the first relative import is what
 * guarantees every model below it is audited.
 *
 * Move it down the file — below a route import, say — and the models pulled in
 * above it silently stop producing audit rows. Nothing throws and nothing is
 * logged; the trail just has holes in it.
 *
 * Side-effect import on purpose: it registers the plugin, it exports nothing
 * this file needs.
 */
import "./services/auditLog.js";
import { requestContext } from "./middlewares/requestContext.js";

import { IS_SERVERLESS, IS_LONG_RUNNING } from "./config/runtime.js";
import { connectDB } from "./config/db.js";

// ============ SECURITY IMPORTS ============
// OWASP-compliant security middleware
import {
  securityHeaders,
  additionalSecurityHeaders,
  getCorsConfig,
  sanitizeErrors
} from "./middlewares/securityHeaders.js";
import {
  generalRateLimiter
} from "./middlewares/rateLimiter.js";
import {
  mongoSanitizer
} from "./middlewares/inputValidator.js";

// ES6 module equivalent of __dirname and __filename
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

globalThis.__basedir = __dirname;

// Create log directory if it doesn't exist.
// Skipped on Vercel: the function filesystem is read-only, so mkdirSync throws
// EROFS at module load and takes down every route on cold start.
if (IS_LONG_RUNNING && !fs.existsSync("log")) {
  fs.mkdirSync("log");
}

// Global error handling to prevent crashes
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  logError(error);
  // Don't exit the process, let it continue running
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  logError({ message: "Unhandled Promise Rejection", error: reason });
  // Don't exit the process, let it continue running
});

// Function to log errors
function logError(error) {
  let filedata = {
    datetime: new Date(),
    message: error?.message,
    stack: error?.stack,
  };
  // No writable disk on Vercel, and nothing could read the file anyway -
  // stderr is picked up by the platform log drain instead.
  if (IS_SERVERLESS) {
    console.error("[error]", filedata);
    return;
  }
  try {
    let writecontent = [];
    if (fs.existsSync("log/error.html")) {
      let filedata = fs.readFileSync("log/error.html");
      if (filedata) {
        try {
          writecontent = JSON.parse(filedata);
        } catch {
          // If parsing fails, start with empty array
          writecontent = [];
        }
      }
    }
    writecontent.push(filedata);
    fs.writeFileSync("log/error.html", JSON.stringify(writecontent));
  } catch (err) {
    console.error("Error logging to file:", err);
  }
}

const app = express();
let databasestatus = "In-Progress";

// Vercel terminates TLS at its edge and forwards plain HTTP to the function, so
// req.secure is false and req.protocol is "http" no matter what the browser
// used. express-session refuses to send a cookie marked Secure over what it
// believes is an insecure connection, so `secure: true` below silently emitted
// NO Set-Cookie at all: login returned 200 and every following request was
// unauthenticated. Trusting one hop makes Express read X-Forwarded-Proto.
//
// It also restores req.ip, which the rate limiters key on and which is recorded
// against failed login attempts - without this every request looks like it came
// from the same address.
//
// Exactly one hop, and only where we know a trusted edge is in front: a wider
// setting would let a client spoof X-Forwarded-For and evade the rate limiter.
if (IS_SERVERLESS) {
  app.set("trust proxy", 1);
}

// ============ SECURITY MIDDLEWARE (Apply FIRST) ============
// 1. Security Headers (Helmet + custom headers)
app.use(securityHeaders);
app.use(additionalSecurityHeaders);

// 2. CORS configuration (more restrictive than before)
/**
 * getCorsConfig takes an allowlist, and was being called with none — so the
 * ALLOWED_ORIGINS env var was dead code and only the four hardcoded defaults
 * were ever honoured. That is not "wide open" (the origin check still runs),
 * but it does mean a deployed front end on a new domain is silently blocked
 * with no way to fix it from config.
 *
 * Comma-separated, e.g. ALLOWED_ORIGINS=https://app.midcitygym.in,https://midcitygym.in
 */
const corsConfig = getCorsConfig(
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
);
app.use(cors(corsConfig));
app.options("*", cors(corsConfig));

// 3. General Rate Limiting (applied to all routes)
app.use(generalRateLimiter);

// 4. Body Parsing with size limits (OWASP: limit request body size)
app.use(bodyParser.json({ limit: "10mb" })); // Reduced from 50mb for security
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

// 5. MongoDB NoSQL Injection Protection
app.use(mongoSanitizer);

// 6. HTTP Parameter Pollution Prevention
app.use(hpp());

// ============ STATIC FILE SERVING ============
app.use("/uploads", express.static("uploads", {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const inlineExtensions = [
      ".pdf", ".png", ".jpg", ".jpeg", ".gif", 
      ".svg", ".webp", ".mp4", ".webm", 
      ".ogg", ".mp3", ".wav"
    ];
    if (inlineExtensions.includes(ext)) {
      res.setHeader("Content-Disposition", "inline");
      if (ext === ".pdf") {
        res.setHeader("Content-Type", "application/pdf");
        res.removeHeader("Content-Security-Policy");
        res.removeHeader("X-Frame-Options");
      }
    }
  }
}));
app.use(express.static("files"));
// Express only serves the admin SPA on the PM2/FTP deployment. On Vercel the
// build is uploaded to the CDN under /admin and this would never be hit.
if (IS_LONG_RUNNING) {
  app.use("/", express.static(path.join(__dirname, "/out/admin")));
}
// NOTE: Removed /log static serving for security - logs should not be publicly accessible

// 7. Express Session - MongoDB Session Storage (persistent)
import MongoStore from "connect-mongo";

/**
 * The session secret signs every staff cookie, so a known value means anyone
 * can forge a staff session.
 *
 * This used to fall back to a hardcoded literal when SESSION_SECRET was unset —
 * and it WAS unset, so that published string was signing real cookies. A
 * fallback is worse than no default here: it turns a fatal misconfiguration
 * into a silent one. Refusing to boot is the safe failure.
 */
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error(
    "❌ SESSION_SECRET is missing or shorter than 32 characters.\n" +
      "   Add a long random value to .env and restart:\n" +
      "     SESSION_SECRET=<48+ random characters>",
  );
  process.exit(1);
}

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'sessionId',
  store: MongoStore.create({
    mongoUrl: process.env.DATABASE,
    collectionName: 'sessions',
    ttl: 24 * 60 * 60, // 24 hours in seconds
    autoRemove: 'native', // Use MongoDB TTL index for cleanup
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
    httpOnly: true, // Prevents XSS attacks
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax' // CSRF protection
  }
}));

console.log("✅ Express session middleware configured (MongoDB storage)");

/**
 * 8. Per-request context (AsyncLocalStorage), for the audit log.
 *
 * ORDER IS THE WHOLE POINT OF THIS LINE:
 *   - AFTER express-session, or `req.session` does not exist yet and every
 *     audit row would be written with no actor;
 *   - BEFORE the route table, or handlers run outside the store and the
 *     mongoose hooks in services/auditLog.js find nothing to attribute a write
 *     to. They fail closed — no actor means no row — so a misplacement here is
 *     an audit log that is quietly empty rather than an error anybody sees.
 *
 * It stores the request itself, not a snapshot of the user: the login handler
 * populates req.session.user partway through a request, and a snapshot taken
 * here would still be null by the time a hook fires.
 */
app.use(requestContext);

mongoose.set("strictQuery", false);
// Query logging is very noisy and echoes document contents into the log drain;
// opt in explicitly rather than shipping it on by default.
mongoose.set("debug", process.env.MONGOOSE_DEBUG === "true");


// Menu seeds moved to scripts/seedMenus.js so CI can run them once per release
// on the serverless target, where boot-time seeding would re-run on every cold
// start. The long-running process still seeds at boot via seedAllMenus().
import { seedAllMenus } from "./scripts/seedMenus.js";

try {
  await connectDB();
  databasestatus = "Connected";
  // Seeding is boot-time work. Serverless containers cold-start constantly, so
  // running it here re-runs both seeds on every scale-out; the deploy pipeline
  // runs `npm run seed:menus` once per release instead.
  if (IS_LONG_RUNNING) {
    await seedAllMenus();
  }
} catch (err) {
  console.error("❌ DB Connection Error =>", err);
  if (err instanceof mongoose.Error.MongooseServerSelectionError) {
    console.error(
      "Server selection failed. Check network, URI, and Atlas IP whitelist.",
    );
  }
}

// Optional: handle runtime disconnects
mongoose.connection.on("disconnected", () => {
  console.warn("⚠️ DB disconnected!");
});

mongoose.connection.on("reconnected", () => {
  console.log("♻️ DB reconnected!");
});

// ============ ADDITIONAL MIDDLEWARE ============
// Development request logging (disable in production for performance)
app.use(morgan("dev"));

// Setup Swagger documentation (consider disabling in production)
// ============ SWAGGER (lazily mounted) ============
// Building the spec globs and JSDoc-parses every file in routes/v1, measured at
// ~4.8 seconds. Importing config/swagger.js at module scope therefore put those
// 4.8s on the critical path of EVERY serverless cold start, to serve a docs page
// that virtually no request asks for - it was the single largest component of
// the slow first load.
//
// Mounted lazily instead: the first hit to /api-docs pays the cost, the built
// router is cached for the life of the container, and nothing else waits. The
// path is matched without a mount prefix so req.url stays intact for the inner
// router.
let swaggerRouterPromise = null;

const buildSwaggerRouter = async () => {
  const [{ default: swaggerSpec }, { default: swaggerUi }] = await Promise.all([
    import("./config/swagger.js"),
    import("swagger-ui-express"),
  ]);

  const router = express.Router();
  router.get("/api-docs.json", (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.send(swaggerSpec);
  });
  router.use(
    "/api-docs",
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      explorer: true,
      customCss: ".swagger-ui .topbar { display: none }",
      customSiteTitle: "Mid City Gym API Documentation",
    }),
  );
  return router;
};

app.use((req, res, next) => {
  if (!req.path.startsWith("/api-docs")) return next();
  swaggerRouterPromise ??= buildSwaggerRouter();
  swaggerRouterPromise
    .then((router) => router(req, res, next))
    .catch((err) => {
      swaggerRouterPromise = null; // let a later request retry
      next(err);
    });
});

// ============ V1 ROUTES ============
// Import v1 routes
import companiesRoutes from "./routes/v1/companies.routes.js";
import currenciesRoutes from "./routes/v1/currencies.routes.js";
import departmentsRoutes from "./routes/v1/departments.routes.js";
import emailsRoutes from "./routes/v1/emails.routes.js";
import employeeRolesRoutes from "./routes/v1/employeeRoles.routes.js";
import employeesRoutes from "./routes/v1/employees.routes.js";
import locationsRoutes from "./routes/v1/locations.routes.js";
import menusRoutes from "./routes/v1/menus.routes.js";
import rolesRoutes from "./routes/v1/roles.routes.js";
import otpRoutes from "./routes/v1/otp.routes.js";
import blogCategoryRoutes from "./routes/v1/blogCategory.routes.js";
import blogTagRoutes from "./routes/v1/blogTag.routes.js";
import blogMasterRoutes from "./routes/v1/blogMaster.routes.js";
import faqCategoryRoutes from "./routes/v1/faqCategory.routes.js";
import faqRoutes from "./routes/v1/faq.routes.js";
import guideRoutes from "./routes/v1/guide.routes.js";
import memberRoutes from "./routes/v1/members.routes.js";
import trainerRoutes from "./routes/v1/trainers.routes.js";
import transactionRoutes from "./routes/v1/transactions.routes.js";
import expenseCategoryRoutes from "./routes/v1/expenseCategories.routes.js";
import memberAuthRoutes from "./routes/v1/memberAuth.routes.js";
import membershipPlanRoutes from "./routes/v1/membershipPlans.routes.js";
import bodyMetricRoutes from "./routes/v1/bodyMetrics.routes.js";
import attendanceRoutes from "./routes/v1/attendance.routes.js";
import workoutRoutes from "./routes/v1/workout.routes.js";
import branchRoutes from "./routes/v1/branches.routes.js";
import siteRoutes from "./routes/v1/site.routes.js";
import reportRoutes from "./routes/v1/reports.routes.js";
import auditLogRoutes from "./routes/v1/auditLog.routes.js";
import classRoutes from "./routes/v1/classes.routes.js";
import jobRoutes from "./routes/v1/jobs.routes.js";

app.use("/api/v1", companiesRoutes);
app.use("/api/v1", currenciesRoutes);
app.use("/api/v1", departmentsRoutes);
app.use("/api/v1", emailsRoutes);
app.use("/api/v1", employeeRolesRoutes);
app.use("/api/v1", employeesRoutes);
app.use("/api/v1", locationsRoutes);
app.use("/api/v1", menusRoutes);
app.use("/api/v1", rolesRoutes);
app.use("/api/v1/otp", otpRoutes);
app.use("/api/v1", blogCategoryRoutes);
app.use("/api/v1", blogTagRoutes);
app.use("/api/v1", blogMasterRoutes);
app.use("/api/v1", faqCategoryRoutes);
app.use("/api/v1", faqRoutes);
app.use("/api/v1", guideRoutes);
app.use("/api/v1", memberRoutes);
app.use("/api/v1", trainerRoutes);
app.use("/api/v1", transactionRoutes);
app.use("/api/v1", expenseCategoryRoutes);
app.use("/api/v1", memberAuthRoutes);
app.use("/api/v1", membershipPlanRoutes);
app.use("/api/v1", bodyMetricRoutes);
app.use("/api/v1", attendanceRoutes);
app.use("/api/v1", workoutRoutes);
app.use("/api/v1", branchRoutes);
// Public website surface (marketing copy, adverts, leads). Must stay under
// /api/ — the SPA catch-all below swallows anything that is not.
app.use("/api/v1", siteRoutes);
// Reports, CSV exports and the audit-log viewer. Same flat mount as everything
// else, and — like every other route file — they must stay under /api/ or the
// SPA catch-all below swallows them.
app.use("/api/v1", reportRoutes);
app.use("/api/v1", auditLogRoutes);
// Phase 5. Class booking: public timetable + free-trial form, the member
// portal's own booking routes, and the staff diary/roster. Same flat mount as
// everything else, and it must stay under /api/ or the SPA catch-all below
// swallows it.
app.use("/api/v1", classRoutes);
// Scheduled jobs (the reminder cron). No session and no menu row - a shared
// secret in CRON_SECRET is the whole of its authentication, see
// controllers/v1/jobs.controller.js.
app.use("/api/v1", jobRoutes);

console.log("✅ V1 API routes loaded");

app.get("/api", (req, res) => {
  res.json({
    status: "ok",
    message: "API server is running",
    database: databasestatus,
    timestamp: new Date().toISOString(),
  });
});



// SPA fallback for the PM2/FTP deployment only. On Vercel this would turn every
// unmatched /api path into a 200 + HTML page instead of a real 404.
if (IS_LONG_RUNNING) {
  app.get("/*", async (req, res) => {
    res.sendFile(path.join(__dirname, "/out/admin", "index.html"));
  });
}

// ============ ERROR HANDLING ============
// Use the secure error sanitizer (prevents information leakage)
app.use(sanitizeErrors);

// Fallback error handler that logs errors but doesn't expose details
// eslint-disable-next-line no-unused-vars
app.use(async (err, req, res, _next) => {
  // Log error to file for debugging
  const errorData = {
    datetime: new Date().toISOString(),
    message: err?.message,
    path: req?.path,
    method: req?.method,
    ip: req?.ip,
    // Don't log full stack trace to file in production
    stack: process.env.NODE_ENV === 'development' ? err?.stack : undefined,
  };

  if (IS_SERVERLESS) {
    // Read-only filesystem - hand the record to the platform log drain.
    console.error("[error]", errorData);
  } else try {
    let writecontent = [];
    if (fs.existsSync("log/error.html")) {
      const filedata = fs.readFileSync("log/error.html", 'utf8');
      if (filedata) {
        try {
          writecontent = JSON.parse(filedata);
        } catch {
          writecontent = [];
        }
      }
    }

    // Keep only last 100 errors to prevent log file from growing too large
    if (writecontent.length > 100) {
      writecontent = writecontent.slice(-100);
    }

    writecontent.push(errorData);
    fs.writeFileSync("log/error.html", JSON.stringify(writecontent, null, 2));
  } catch (logErr) {
    console.error("Error logging to file:", logErr);
  }

  // SECURITY: Don't expose internal error details to users
  const isProduction = process.env.NODE_ENV === 'production';
  return res.status(500).json({
    isOk: false,
    status: 500,
    error: 'Internal Server Error',
    message: isProduction ? 'An unexpected error occurred' : err?.message,
  });
});

const port = process.env.PORT || 8000;

// Vercel imports this module and drives `app` as a request handler; binding a
// port there is neither possible nor needed.
if (IS_LONG_RUNNING) {
  app.listen(port, () => {
    console.log(`✅ Server is running on port ${port}`);
    console.log(`🔒 Security middleware enabled: Helmet, Rate Limiting, Input Validation, CSRF Protection`);
  });
}

export default app;
