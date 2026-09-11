// utils/sanitize.js  ← create this helper once, reuse everywhere
export const sanitizeString = (value) => {
  if (typeof value !== "string") return null;
  return value.trim();
};

export const isValidEmail = (value) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(value);
};