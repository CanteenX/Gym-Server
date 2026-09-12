import mongoose from "mongoose";

/**
 * Serverless-safe Mongo connection.
 *
 * A serverless function is frozen and thawed between requests, and a single
 * container handles many requests. Calling `mongoose.connect` per request would
 * open a new pool every time and exhaust Atlas connection limits, so the
 * connection promise is cached on globalThis - module scope is not enough,
 * because the module registry can be re-evaluated while the container survives.
 */
const cache = (globalThis.__gymMongoCache ??= { conn: null, promise: null });

export function dbStatus() {
  // 1 === connected, per mongoose.ConnectionStates
  return mongoose.connection.readyState === 1 ? "Connected" : "In-Progress";
}

export async function connectDB() {
  if (cache.conn) return cache.conn;

  if (!cache.promise) {
    const dbURI = process.env.DATABASE;
    if (!dbURI) throw new Error("DATABASE env var is not set");

    // useNewUrlParser / useUnifiedTopology were removed in Mongoose 8 - passing
    // them now logs a deprecation warning on every cold start.
    cache.promise = mongoose
      .connect(dbURI, {
        serverSelectionTimeoutMS: 10000,
        // Keep the pool small: many concurrent lambdas x a large pool will hit
        // the Atlas connection cap long before the app is actually busy.
        maxPoolSize: 10,
      })
      .then((m) => {
        console.log("✅ DB connected");
        return m;
      })
      .catch((err) => {
        // Clear the cached promise so the next invocation can retry instead of
        // permanently re-awaiting a rejected promise.
        cache.promise = null;
        throw err;
      });
  }

  cache.conn = await cache.promise;
  return cache.conn;
}
