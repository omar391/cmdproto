/**
 * Deterministic CLI failures for the cmdproto install commands.
 *
 * Every failure carries a stable code, a human-readable message, one of the
 * documented exit classes, and non-secret diagnostic details so the commands
 * can emit one machine-readable error object.
 */

export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;
export const EXIT_ENVIRONMENT = 4;

export class InstallError extends Error {
  /**
   * @param {string} code Stable error code.
   * @param {string} message Human-readable explanation.
   * @param {number} exitCode Documented exit class.
   * @param {Record<string, unknown>} [details] Non-secret diagnostics.
   */
  constructor(code, message, exitCode, details = {}) {
    super(message);
    this.name = "InstallError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function usageError(message) {
  return new InstallError("INVALID_USAGE", message, EXIT_USAGE);
}

export function verifyError(code, message, details = {}) {
  return new InstallError(code, message, EXIT_USAGE, details);
}

export function refusalError(code, message, details = {}) {
  return new InstallError(code, message, EXIT_REFUSED, details);
}

export function environmentError(code, message, details = {}) {
  return new InstallError(code, message, EXIT_ENVIRONMENT, details);
}
