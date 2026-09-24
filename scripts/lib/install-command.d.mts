export declare const INSTALL_RESULT_SCHEMA: "cmdproto.install-result/v1";
export declare const ERROR_SCHEMA: "cmdproto.error/v1";

export interface InstallOverrides {
  readonly platform?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly cwd?: string;
  readonly windowsPath?: { read(): string; write(value: string): unknown };
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

export declare function getInstallUsage(): string;
export declare function getUninstallUsage(): string;
export declare function parseInstallArgs(argv: readonly string[], command: "install" | "uninstall"): { cwd?: string; name?: string; runScript?: string; sourceEnv?: string; force: boolean; help: boolean };
export declare function runInstall(argv: readonly string[], overrides?: InstallOverrides): number;
export declare function runUninstall(argv: readonly string[], overrides?: InstallOverrides): number;
