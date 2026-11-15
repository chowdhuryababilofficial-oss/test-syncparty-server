const crypto = require("crypto");

// Derive a feature-specific signing key from the server-only Supabase secret.
// An explicit dedicated key can override it without exposing any secret to clients.
function signingKey() {
  const source = String(process.env.HIGHLIGHT_SIGNING_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "");
  if (!source) return null;
  return crypto.createHmac("sha256", source).update("syncparty:highlight-message-proof:v1").digest();
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
}
function signedFields(message) {
  return {
    version: 1,
    room: String(message.highlightRoom || ""),
    messageId: String(message.messageId || ""),
    authorId: String(message.authorId || ""),
    authorAccountId: message.authorAccountId == null ? null : String(message.authorAccountId),
    name: String(message.name || message.authorName || "Guest"),
    avatar: String(message.avatar || message.authorAvatar || "🙂"),
    color: String(message.color || message.authorColor || "#54a0ff"),
    sentAt: Number(message.sentAt) || 0,
    text: String(message.text || ""),
    replyTo: message.replyTo || null,
    mediaSnapshot: message.mediaSnapshot || null
  };
}
function signHighlightMessage(message) {
  const key = signingKey();
  if (!key) return null;
  const bytes = Buffer.from(JSON.stringify(stable(signedFields(message))));
  return "v1." + crypto.createHmac("sha256", key).update(bytes).digest("base64url");
}
function verifyHighlightMessage(message) {
  const key = signingKey();
  if (!key || typeof message?.highlightProof !== "string" || !message.highlightProof.startsWith("v1.")) return false;
  const expected = signHighlightMessage(message);
  if (!expected) return false;
  const a = Buffer.from(expected), b = Buffer.from(message.highlightProof);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
module.exports = { signHighlightMessage, verifyHighlightMessage };
