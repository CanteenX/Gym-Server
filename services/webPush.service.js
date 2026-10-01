import crypto from "crypto";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { URL } from "url";
import PushSubscription from "../models/PushSubscription.js";

/**
 * Pure Node.js Web Push protocol implementation (RFC 8030, RFC 8291, RFC 8292).
 * Operates without external npm dependencies using Node's native crypto and https.
 */

// Persistent or environment-provided VAPID Keypair (P-256 / prime256v1)
let VAPID_KEYS = null;
const VAPID_FILE = path.join(process.cwd(), "vapid.json");

export function getVapidKeys() {
  if (VAPID_KEYS) return VAPID_KEYS;

  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    VAPID_KEYS = {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
    return VAPID_KEYS;
  }

  // Check if persisted vapid.json exists
  try {
    if (fs.existsSync(VAPID_FILE)) {
      const saved = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8"));
      if (saved?.publicKey && saved?.privateKey && saved.privateKey !== "VAPID_DEFAULT_PRIVATE_KEY_SET") {
        VAPID_KEYS = saved;
        return VAPID_KEYS;
      }
    }
  } catch (e) {
    console.warn("Failed to read vapid.json:", e.message);
  }

  // Generate self-contained EC keypair on prime256v1
  const curve = crypto.createECDH("prime256v1");
  curve.generateKeys();

  let publicKeyBuffer = curve.getPublicKey();
  let privateKeyBuffer = curve.getPrivateKey();

  // Zero-pad to ensure exact byte lengths (32 bytes private, 65 bytes uncompressed public)
  if (privateKeyBuffer.length < 32) {
    const pad = Buffer.alloc(32 - privateKeyBuffer.length, 0);
    privateKeyBuffer = Buffer.concat([pad, privateKeyBuffer]);
  }
  if (publicKeyBuffer.length < 65) {
    const pad = Buffer.alloc(65 - publicKeyBuffer.length, 0);
    publicKeyBuffer = Buffer.concat([pad, publicKeyBuffer]);
  }

  VAPID_KEYS = {
    publicKey: publicKeyBuffer.toString("base64url"),
    privateKey: privateKeyBuffer.toString("base64url"),
  };

  try {
    fs.writeFileSync(VAPID_FILE, JSON.stringify(VAPID_KEYS, null, 2), "utf8");
    console.log("Generated and persisted new VAPID keys to", VAPID_FILE);
  } catch (e) {
    console.warn("Could not persist vapid.json:", e.message);
  }

  return VAPID_KEYS;
}

/**
 * Base64 URL encode utility
 */
function base64Url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlToBuffer(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

/**
 * Signs a VAPID JWT token for Web Push authorization
 */
function createVapidJwt(audience, subject = "mailto:admin@midcitygym.in") {
  const { publicKey, privateKey } = getVapidKeys();
  const header = { alg: "ES256", typ: "JWT" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600, // 12 hours
    sub: subject,
  };

  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const message = `${encodedHeader}.${encodedPayload}`;

  // Build PKCS8 PEM from raw 32-byte EC private key
  const privKeyBuf = base64UrlToBuffer(privateKey);
  const pubKeyBuf = base64UrlToBuffer(publicKey);

  // Convert raw EC private key to PEM using crypto.createPrivateKey
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: base64Url(pubKeyBuf.subarray(1, 33)),
    y: base64Url(pubKeyBuf.subarray(33, 65)),
    d: base64Url(privKeyBuf),
  };

  const keyObject = crypto.createPrivateKey({ format: "jwk", key: jwk });
  const sign = crypto.createSign("SHA256");
  sign.update(message);
  sign.end();
  const derSignature = sign.sign({ key: keyObject, dsaEncoding: "ieee-p1363" });

  const signature = base64Url(derSignature);
  return `${message}.${signature}`;
}

/**
 * RFC 8291: Message Encryption for Web Push (aes128gcm)
 */
function encryptPayload(clientP256dh, clientAuth, payloadString) {
  const userPublicKey = base64UrlToBuffer(clientP256dh);
  const userAuth = base64UrlToBuffer(clientAuth);
  const payload = Buffer.from(payloadString, "utf8");

  // Local ephemeral ECDH keypair
  const localEcdh = crypto.createECDH("prime256v1");
  localEcdh.generateKeys();
  const localPublicKey = localEcdh.getPublicKey(); // 65 bytes uncompressed

  // 1. Shared secret
  const sharedSecret = localEcdh.computeSecret(userPublicKey);

  // 2. PRK = HKDF-Extract(salt=userAuth, IKM=sharedSecret)
  // info = "WebPush: info\0" || userPublicKey || localPublicKey
  const authInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    userPublicKey,
    localPublicKey,
  ]);
  const ikm = crypto.hkdfSync("sha256", sharedSecret, userAuth, authInfo, 32);

  // 3. Random 16-byte salt
  const salt = crypto.randomBytes(16);

  // 4. CEK (Content Encryption Key) = 16 bytes
  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0", "utf8");
  const cek = crypto.hkdfSync("sha256", ikm, salt, cekInfo, 16);

  // 5. Nonce = 12 bytes
  const nonceInfo = Buffer.from("Content-Encoding: nonce\0", "utf8");
  const nonce = crypto.hkdfSync("sha256", ikm, salt, nonceInfo, 12);

  // 6. Delimiter byte \x02 at the end of the plaintext (RFC 8291 section 4)
  const padded = Buffer.concat([payload, Buffer.from([0x02])]);

  // 7. AES-128-GCM encryption
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // 8. RFC 8291 header:
  // salt (16) || rs (4) || idlen (1) || keyid (65)
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0); // record size
  const idlen = Buffer.from([65]); // localPublicKey length

  const body = Buffer.concat([
    salt,
    rs,
    idlen,
    localPublicKey,
    ciphertext,
    authTag,
  ]);

  return body;
}

/**
 * Dispatches a push notification to a single PushSubscription document.
 */
export async function sendWebPush(subscription, payload) {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return { success: false, reason: "Invalid subscription" };
  }

  const { endpoint, keys } = subscription;
  const payloadString =
    typeof payload === "string" ? payload : JSON.stringify(payload);

  let body;
  try {
    body = encryptPayload(keys.p256dh, keys.auth, payloadString);
  } catch (err) {
    console.error("Encryption error for push:", err.message);
    return { success: false, reason: "Encryption failed" };
  }

  const parsedUrl = new URL(endpoint);
  const audience = `${parsedUrl.protocol}//${parsedUrl.host}`;
  const jwt = createVapidJwt(audience);
  const { publicKey } = getVapidKeys();

  const headers = {
    TTL: "86400",
    Urgency: "high",
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    "Content-Length": body.length,
    Authorization: `vapid t=${jwt}, k=${publicKey}`,
  };

  return new Promise((resolve) => {
    const isHttps = parsedUrl.protocol === "https:";
    const transport = isHttps ? https : http;

    const req = transport.request(
      endpoint,
      {
        method: "POST",
        headers,
        timeout: 10000,
      },
      (res) => {
        let resData = "";
        res.on("data", (chunk) => {
          resData += chunk;
        });
        res.on("end", async () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, statusCode: res.statusCode });
          } else {
            // 404 Not Found or 410 Gone means the subscription expired/uninstalled
            if (res.statusCode === 404 || res.statusCode === 410) {
              await PushSubscription.updateOne(
                { _id: subscription._id },
                { active: false }
              );
            }
            resolve({
              success: false,
              statusCode: res.statusCode,
              body: resData,
            });
          }
        });
      }
    );

    req.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ success: false, error: "Request timed out" });
    });

    req.write(body);
    req.end();
  });
}
