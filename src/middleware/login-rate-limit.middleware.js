// In-memory login attempt tracker
// Resets on API restart (by design)
// Cleanup happens lazily: expired entries are removed when the same IP tries again
const loginAttempts = new Map();

const loginRateLimiter = (req, res, next) => {
  const ip = req.headers['x-real-ip'] || req.ip;
  const now = Date.now();

  const maxAttempts = parseInt(process.env.RATE_LIMIT_MAX_LOGIN) || 5;
  const windowMs = (parseInt(process.env.RATE_LIMIT_LOGIN_WINDOW) || 15) * 60 * 1000;
  const blockDurationMs = (parseInt(process.env.RATE_LIMIT_LOGIN_BLOCK) || 30) * 60 * 1000;

  let record = loginAttempts.get(ip);

  if (!record) {
    record = { attempts: [], blockedUntil: null };
    loginAttempts.set(ip, record);
  }

  // Check if IP is currently blocked
  if (record.blockedUntil && now < record.blockedUntil) {
    const retryAfter = Math.ceil((record.blockedUntil - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: 'Too many login attempts. Please try again later.',
      retryAfter
    });
  }

  // If block has expired, reset record
  if (record.blockedUntil && now >= record.blockedUntil) {
    record = { attempts: [], blockedUntil: null };
    loginAttempts.set(ip, record);
  }

  // Remove attempts outside the current window
  record.attempts = record.attempts.filter(t => now - t < windowMs);

  // Check if max attempts reached within window
  if (record.attempts.length >= maxAttempts) {
    record.blockedUntil = now + blockDurationMs;
    loginAttempts.set(ip, record);
    const retryAfter = Math.ceil(blockDurationMs / 1000);
    res.set('Retry-After', String(retryAfter));
    console.warn(`Login rate limit exceeded for IP ${ip} - blocked for ${blockDurationMs / 60000} minutes`);
    return res.status(429).json({
      error: 'Too many login attempts. Please try again later.',
      retryAfter
    });
  }

  // Track this attempt
  record.attempts.push(now);
  loginAttempts.set(ip, record);

  // Pass remaining attempts to the route handler
  res.locals.remainingLoginAttempts = maxAttempts - record.attempts.length;

  next();
};

const resetLoginAttempts = (req) => {
  const ip = req.headers['x-real-ip'] || req.ip;
  loginAttempts.delete(ip);
};

module.exports = { loginRateLimiter, resetLoginAttempts };
