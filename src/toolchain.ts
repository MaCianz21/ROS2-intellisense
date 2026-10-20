import * as fs from 'fs';
import * as path from 'path';

export type RosPlatform = 'linux' | 'wsl' | 'macos' | 'windows' | 'unknown';

export interface CompilerOptions {
    /** `ros2IntelliSense.compilerPath`, highest priority. */
    configured?: string;
    /** `C_Cpp.default.compilerPath`, so the provider does not override it. */
    cppToolsDefault?: string;
    env?: NodeJS.ProcessEnv;
    exists?: (candidate: string) => boolean;
}

export function detectPlatform(): RosPlatform {
    switch (process.platform) {
        case 'linux':
            try {
                const release = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
                return release.includes('microsoft') || release.includes('wsl') ? 'wsl' : 'linux';
            } catch {
                return 'linux';
            }
        case 'darwin':
            return 'macos';
        case 'win32':
            return 'windows';
        default:
            return 'unknown';
    }
}

function findOnPath(
    command: string,
    env: NodeJS.ProcessEnv,
    exists: (candidate: string) => boolean,
): string | undefined {
    const names =
        process.platform === 'win32' && !path.extname(command)
            ? [command, `${command}.exe`]
            : [command];
    for (const dir of (env.PATH ?? '').split(path.delimiter)) {
        if (!dir) {
            continue;
        }
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (exists(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}

/**
 * Resolve the compiler used for IntelliSense.
 *
 * Precedence: `ros2IntelliSense.compilerPath` → `C_Cpp.default.compilerPath` →
 * `$CXX` → a platform default that prefers the **C++** driver (the C driver does
 * not report the C++ standard library include paths). Both `g++` and `clang++`
 * are recognised, so `intelliSenseModeFor` can pick the matching mode.
 */
export function detectCompilerPath(
    platform: RosPlatform,
    options: CompilerOptions = {},
): string {
    const env = options.env ?? process.env;
    const exists = options.exists ?? fs.existsSync;

    const configured = options.configured?.trim();
    if (configured) {
        return configured;
    }
    const cppToolsDefault = options.cppToolsDefault?.trim();
    if (cppToolsDefault) {
        return cppToolsDefault;
    }

    const cxx = env.CXX?.trim();
    if (cxx) {
        const resolved = path.isAbsolute(cxx) ? cxx : findOnPath(cxx, env, exists);
        if (resolved && exists(resolved)) {
            return resolved;
        }
    }

    const candidates =
        platform === 'macos'
            ? [
                  '/opt/homebrew/bin/g++-14',
                  '/opt/homebrew/bin/g++-13',
                  '/usr/local/bin/g++',
                  '/usr/bin/clang++',
                  '/usr/bin/clang',
              ]
            : platform === 'windows'
              ? ['cl.exe', 'g++.exe', 'clang++.exe']
              : ['g++', '/usr/bin/g++', '/usr/local/bin/g++', 'clang++', '/usr/bin/clang++', '/usr/bin/gcc'];

    for (const candidate of candidates) {
        if (path.isAbsolute(candidate)) {
            if (exists(candidate)) {
                return candidate;
            }
            continue;
        }
        const found = findOnPath(candidate, env, exists);
        if (found) {
            return found;
        }
    }

    // Prefixes other than /usr (conda, Nix, custom builds) are only on PATH.
    for (const command of platform === 'windows' ? [] : ['g++', 'clang++', 'gcc']) {
        const found = findOnPath(command, env, exists);
        if (found) {
            return found;
        }
    }

    return platform === 'macos'
        ? '/usr/bin/clang'
        : platform === 'windows'
          ? 'cl.exe'
          : '/usr/bin/gcc';
}

function cpptoolsArch(arch: string): string {
    switch (arch) {
        case 'ia32':
            return 'x86';
        case 'arm64':
            return 'arm64';
        case 'arm':
            return 'arm';
        default:
            return 'x64';
    }
}

/**
 * cpptools `intelliSenseMode` for the platform, compiler and architecture.
 * Jazzy/Tier 1 includes arm64 (Jetson, Raspberry Pi), so x64 is not a safe
 * assumption.
 */
export function intelliSenseModeFor(
    platform: RosPlatform,
    compilerPath = '',
    arch: string = process.arch,
): string {
    const target = cpptoolsArch(arch);
    const name = (compilerPath.split(/[\\/]/).pop() ?? '').toLowerCase();
    const clang = name.includes('clang');
    const gcc = !clang && (name.includes('gcc') || name.includes('g++'));

    switch (platform) {
        case 'macos':
            return gcc ? `macos-gcc-${target}` : `macos-clang-${target}`;
        case 'windows':
            if (/^cl(\.exe)?$/.test(name)) {
                return `windows-msvc-${target}`;
            }
            return clang ? `windows-clang-${target}` : `windows-gcc-${target}`;
        default:
            return clang ? `linux-clang-${target}` : `linux-gcc-${target}`;
    }
}
