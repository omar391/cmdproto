export declare const COMMAND_PATTERN: RegExp;
export declare const SOURCE_ENV_PATTERN: RegExp;

export interface ResolvedRepository {
  readonly checkout: string;
  readonly manifest: Record<string, unknown>;
  readonly manifestPath: string;
  readonly selfMode: boolean;
  readonly selfEntry: string | null;
  readonly runScript: string | undefined;
  readonly packageManager: string | undefined;
  readonly sourceEnv: string | undefined;
}

export declare function validateCommandName(command: string): string;
export declare function resolvePackageManager(manifest: Record<string, unknown>): string;
export declare function resolveSourceEnv(sourceEnv: string | undefined): string | undefined;
export declare function resolveRepository(options: { readonly cwd?: string; readonly name?: string; readonly runScript?: string; readonly sourceEnv?: string }, defaults: { readonly cwd: string }, settings?: { readonly requireRunScript?: boolean }): ResolvedRepository;
export declare function resolveCommandName(options: { readonly name?: string }, resolved: ResolvedRepository): string;
