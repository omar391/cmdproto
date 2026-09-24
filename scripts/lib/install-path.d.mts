export declare const POSIX_BLOCK_BEGIN: "# >>> cmdproto managed PATH >>>";
export declare const POSIX_BLOCK_END: "# <<< cmdproto managed PATH <<<";
export declare const POSIX_BLOCK_BODY: "export PATH=\"$HOME/.local/bin:$PATH\"";
export declare const FISH_MANAGED_MARKER: "# cmdproto managed PATH";
export declare const FISH_MANAGED_BODY: "fish_add_path --prepend --move \"$HOME/.local/bin\"";

export interface PathConfiguration {
  readonly action: "added" | "updated" | "unchanged";
  readonly target: string;
  readonly shell?: string;
}

export declare function detectShell(env: NodeJS.ProcessEnv): "zsh" | "bash" | "fish" | "profile";
export declare function shellConfigTarget(shell: string, env: NodeJS.ProcessEnv, home: string): string;
export declare function expandWindowsEntry(value: string, home: string): string;
export declare function pathContainsDirectory(binDirectory: string, env: NodeJS.ProcessEnv, platform: string): boolean;
export declare function configurePosixShellFile(targetPath: string): PathConfiguration;
export declare function configureFishFile(targetPath: string): PathConfiguration;
export declare function defaultWindowsPathAdapter(): { read(): string; write(value: string): unknown };
export declare function configureWindowsPath(binDirectory: string, adapter: { read(): string; write(value: string): unknown }, home: string): PathConfiguration;
export declare function ensurePathConfigured(binDirectory: string, context: { readonly platform: string; readonly env: NodeJS.ProcessEnv; readonly home: string; readonly windowsPath?: { read(): string; write(value: string): unknown } }): PathConfiguration & { readonly shell: string };
