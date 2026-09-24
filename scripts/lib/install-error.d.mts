export declare const EXIT_USAGE: 2;
export declare const EXIT_REFUSED: 3;
export declare const EXIT_ENVIRONMENT: 4;

export declare class InstallError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, exitCode: number, details?: Record<string, unknown>);
}

export declare function usageError(message: string): InstallError;
export declare function verifyError(code: string, message: string, details?: Record<string, unknown>): InstallError;
export declare function refusalError(code: string, message: string, details?: Record<string, unknown>): InstallError;
export declare function environmentError(code: string, message: string, details?: Record<string, unknown>): InstallError;

