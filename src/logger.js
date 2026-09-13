/**
 * IPv6 Bridge - Logger
 *
 * Minimal structured logger with level filtering.
 * Respects the LOG_LEVEL environment variable (default: 'info').
 *
 * Levels: silent < error < warn < info < debug
 *
 * @module logger
 */

const LEVELS = { silent: -1, error: 0, warn: 1, info: 2, debug: 3 };

const currentLevel = LEVELS[
  (process.env.LOG_LEVEL || 'info').toLowerCase()
] ?? LEVELS.info;

function timestamp() {
  return new Date().toISOString();
}

function format(level, msg) {
  return `[${timestamp()}] [${level.toUpperCase()}] ${msg}`;
}

module.exports = {
  error(msg) {
    if (currentLevel >= LEVELS.error) {
      console.error(format('error', msg));
    }
  },
  warn(msg) {
    if (currentLevel >= LEVELS.warn) {
      console.warn(format('warn', msg));
    }
  },
  info(msg) {
    if (currentLevel >= LEVELS.info) {
      console.log(format('info', msg));
    }
  },
  debug(msg) {
    if (currentLevel >= LEVELS.debug) {
      console.log(format('debug', msg));
    }
  },
};
