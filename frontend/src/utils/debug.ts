/**
 * Debug logging utility
 * Only logs in development mode (import.meta.env.DEV)
 * Production builds will have all debug logs stripped out
 */

const isDev = import.meta.env.DEV;

export const debug = {
  log: (...args: any[]) => {
    if (isDev) {
      console.log(...args);
    }
  },
  debug: (...args: any[]) => {
    if (isDev) {
      console.debug(...args);
    }
  },
  info: (...args: any[]) => {
    if (isDev) {
      console.info(...args);
    }
  },
  warn: (...args: any[]) => {
    // Warnings are always shown, but can be disabled in production if needed
    if (isDev) {
      console.warn(...args);
    }
  },
  error: (...args: any[]) => {
    // Errors are always shown for production debugging
    console.error(...args);
  }
};





