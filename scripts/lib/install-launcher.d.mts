export declare const LAUNCHER_SCHEMA: "cmdproto.launcher/v1";
export declare const LAUNCHER_OWNER: "cmdproto";
export declare const LAUNCHER_MARKER: "cmdproto-launcher:";
export declare const POSIX_METADATA_PREFIX: "// ";
export declare const WINDOWS_METADATA_PREFIX: "rem ";

export type PackageManagerName = "npm" | "bun" | "pnpm" | "yarn";

export interface LauncherMetadata {
  readonly schema: string;
  readonly owner: string;
  readonly command: string;
  readonly kind: "self" | "consumer";
  readonly sourceCheckout: string;
  readonly sourceEnv: string;
  readonly entry: string | null;
  readonly runScript: string | null;
  readonly packageManager: PackageManagerName | null;
}

export interface LauncherPlan {
  readonly metadata: LauncherMetadata;
  readonly windows: boolean;
  readonly primaryPath: string;
  readonly companionPath: string | null;
  readonly primaryContents: string;
  readonly companionContents: string | null;
}

export interface LauncherInspection {
  readonly state: "absent" | "managed" | "foreign";
  readonly path: string;
  readonly metadata: LauncherMetadata | null;
}

export interface LauncherTargetState {
  readonly primary: LauncherInspection;
  readonly companion: LauncherInspection | null;
  readonly state: "absent" | "managed" | "foreign" | "partial";
}

export declare const PACKAGE_MANAGERS: Readonly<Record<PackageManagerName, { readonly executable: string; readonly argumentStyle: "separator" | "direct" }>>;
export declare const FORWARDED_SIGNALS: readonly string[];

export declare function renderMetadata(metadata: LauncherMetadata): string;
export declare function metadataLine(metadata: LauncherMetadata, prefix: string): string;
export declare function renderPosixLauncher(metadata: LauncherMetadata): string;
export declare function renderCompanionLauncher(metadata: LauncherMetadata): string;
export declare function renderWindowsCommand(metadata: LauncherMetadata): string;
export declare function parseLauncherMetadata(text: string): LauncherMetadata | null;
export declare function inspectLauncherFile(targetPath: string, role: "posix" | "windows-primary" | "windows-companion"): LauncherInspection;
export declare function deriveSourceEnv(command: string): string;
export declare function buildLauncherPlan(command: string, resolved: { readonly selfMode: boolean; readonly checkout: string; readonly selfEntry: string | null; readonly runScript: string | undefined; readonly packageManager: string | undefined; readonly sourceEnv?: string }, binDirectory: string, platform: string): LauncherPlan;
export declare function inspectLauncherTargets(plan: LauncherPlan): LauncherTargetState;
