/**
 * Vercel serverless entry point.
 *
 * An Express app IS a (req, res) function, so it can be handed to Vercel
 * directly. It is wrapped here only so a failed cold-start DB connect can be
 * retried on the next request instead of serving 500s until the container is
 * recycled - connectDB() clears its cached promise on rejection.
 *
 * Vercel preserves the ORIGINAL request path through a rewrite, so Express
 * still sees /api/v1/... and its existing route table works unchanged.
 */
import app from "../server.js";
import { connectDB } from "../config/db.js";

export default async function handler(req, res) {
  try {
    await connectDB();
  } catch (err) {
    console.error("❌ DB unavailable for request", req.url, err?.message);
    return res.status(503).json({
      isOk: false,
      status: 503,
      message: "Database unavailable. Please try again shortly.",
    });
  }
  return app(req, res);
}
