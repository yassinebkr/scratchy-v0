/**
 * Password — Argon2id hashing and verification
 * 
 * Uses argon2id (memory-hard, GPU-resistant) with tuned parameters.
 * Also includes password strength validation.
 */

const argon2 = require("argon2");

// Argon2id parameters (OWASP recommended for 2024+)
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,    // 64 MB
  timeCost: 3,          // 3 iterations
  parallelism: 4,       // 4 threads
};

// Common passwords to reject (top 100 — expand as needed)
const COMMON_PASSWORDS = new Set([
  "password", "123456", "12345678", "qwerty", "abc123", "monkey", "1234567",
  "letmein", "trustno1", "dragon", "baseball", "iloveyou", "master", "sunshine",
  "ashley", "bailey", "passw0rd", "shadow", "123123", "654321", "superman",
  "qazwsx", "michael", "football", "password1", "password123", "welcome",
  "admin", "login", "starwars", "solo", "princess", "cheese",
]);

/**
 * Hash a password with Argon2id
 * @param {string} password - Plaintext password
 * @returns {Promise<string>} Argon2id hash string
 */
async function hashPassword(password) {
  return argon2.hash(password, HASH_OPTIONS);
}

/**
 * Verify a password against a hash
 * @param {string} hash - Argon2id hash string
 * @param {string} password - Plaintext password to check
 * @returns {Promise<boolean>} true if match
 */
async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * Validate password strength
 * @param {string} password
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePassword(password) {
  const errors = [];

  if (!password || typeof password !== "string") {
    return { valid: false, errors: ["Password is required"] };
  }

  if (password.length < 12) {
    errors.push("Password must be at least 12 characters");
  }

  if (password.length > 128) {
    errors.push("Password must be at most 128 characters");
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    errors.push("This password is too common");
  }

  // Check for at least 2 character classes
  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/[0-9]/.test(password)) classes++;
  if (/[^a-zA-Z0-9]/.test(password)) classes++;
  if (classes < 2) {
    errors.push("Password must contain at least 2 character types (lowercase, uppercase, numbers, symbols)");
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { hashPassword, verifyPassword, validatePassword };
