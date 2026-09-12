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
import { setupSwagger } from "./config/swagger.js";

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

// Create log directory if it doesn't exist
if (!fs.existsSync("log")) {
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
app.use("/", express.static(path.join(__dirname, "/out/admin")));
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

mongoose.set("strictQuery", false);
mongoose.set("debug", true);

const dbURI = process.env.DATABASE;

import MenuGroupMaster from "./models/MenuGroupMaster.js";
import MenuMaster from "./models/MenuMaster.js";

const seedFaqMenus = async () => {
  try {
    const setupGroup = await MenuGroupMaster.findOne({ menuGroupName: "Setup" });
    if (!setupGroup) {
      console.log("⚠️ Setup menu group not found. Cannot seed FAQ menus.");
      return;
    }

    // 1. Create or Find "Faq Master" parent menu under Setup
    let faqMasterMenu = await MenuMaster.findOne({
      menuName: "Faq Master",
      menuGroup: setupGroup._id,
    });

    if (!faqMasterMenu) {
      faqMasterMenu = new MenuMaster({
        menuName: "Faq Master",
        menuGroup: setupGroup._id,
        menuUrl: "#",
        sequence: 6,
        isActive: true,
        isParent: true,
        parentMenu: null,
        icon: "ri-question-answer-line",
      });
      await faqMasterMenu.save();
      console.log("✅ Seeded parent FAQ Master menu");
    }

    // 2. Create or Find "FAQ Categories" child menu
    let faqCategoryMenu = await MenuMaster.findOne({
      menuName: "FAQ Categories",
      parentMenu: faqMasterMenu._id,
    });

    if (!faqCategoryMenu) {
      faqCategoryMenu = new MenuMaster({
        menuName: "FAQ Categories",
        menuGroup: setupGroup._id,
        menuUrl: "/faq-category",
        sequence: 1,
        isActive: true,
        isParent: false,
        parentMenu: faqMasterMenu._id,
      });
      await faqCategoryMenu.save();
      console.log("✅ Seeded child FAQ Categories menu");
    }

    // 3. Create or Find "FAQs" child menu
    let faqsMenu = await MenuMaster.findOne({
      menuName: "FAQs",
      parentMenu: faqMasterMenu._id,
    });

    if (!faqsMenu) {
      faqsMenu = new MenuMaster({
        menuName: "FAQs",
        menuGroup: setupGroup._id,
        menuUrl: "/faq",
        sequence: 2,
        isActive: true,
        isParent: false,
        parentMenu: faqMasterMenu._id,
      });
      await faqsMenu.save();
      console.log("✅ Seeded child FAQs menu");
    }
  } catch (err) {
    console.error("❌ Error seeding FAQ menus =>", err);
  }
};

const seedHelpAndGuideMenus = async () => {
  try {
    let helpGroup = await MenuGroupMaster.findOne({ menuGroupName: "Help and Guide" });
    if (!helpGroup) {
      helpGroup = new MenuGroupMaster({
        menuGroupName: "Help and Guide",
        sequence: 5,
        isActive: true,
        isLink: false,
        menuUrl: "#",
        icon: "ri-customer-service-line",
      });
      await helpGroup.save();
      console.log("✅ Seeded Help and Guide menu group");
    }

    let guidesGalleryMenu = await MenuMaster.findOne({
      menuName: "Guides Gallery",
      menuGroup: helpGroup._id,
    });

    if (!guidesGalleryMenu) {
      guidesGalleryMenu = new MenuMaster({
        menuName: "Guides Gallery",
        menuGroup: helpGroup._id,
        menuUrl: "/guides-gallery",
        sequence: 1,
        isActive: true,
        isParent: false,
        parentMenu: null,
      });
      await guidesGalleryMenu.save();
      console.log("✅ Seeded Guides Gallery menu");
    }

    let manageGuidesMenu = await MenuMaster.findOne({
      menuName: "Manage Guides",
      menuGroup: helpGroup._id,
    });

    if (!manageGuidesMenu) {
      manageGuidesMenu = new MenuMaster({
        menuName: "Manage Guides",
        menuGroup: helpGroup._id,
        menuUrl: "/manage-guides",
        sequence: 2,
        isActive: true,
        isParent: false,
        parentMenu: null,
      });
      await manageGuidesMenu.save();
      console.log("✅ Seeded Manage Guides menu");
    }
  } catch (err) {
    console.error("❌ Error seeding Help and Guide menus =>", err);
  }
};

try {
  await mongoose.connect(dbURI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 10000,
  });
  console.log("✅ DB connected");
  databasestatus = "Connected";
  await seedFaqMenus();
  await seedHelpAndGuideMenus();
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
setupSwagger(app);

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

console.log("✅ V1 API routes loaded");

app.get("/api", (req, res) => {
  res.json({
    status: "ok",
    message: "API server is running",
    database: databasestatus,
    timestamp: new Date().toISOString(),
  });
});



app.get("/*", async (req, res) => {
  res.sendFile(path.join(__dirname, "/out/admin", "index.html"));
});

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

  try {
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

app.listen(port, () => {
  console.log(`✅ Server is running on port ${port}`);
  console.log(`🔒 Security middleware enabled: Helmet, Rate Limiting, Input Validation, CSRF Protection`);
});
