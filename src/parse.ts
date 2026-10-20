/**
 * Pure parsing helpers.
 *
 * This module deliberately has **no** `vscode` imports so the logic can be
 * exercised with plain Node (see `src/test/runTests.ts`).
 */

export function dedupe<T>(items: Iterable<T>): T[] {
    return [...new Set(items)];
}

function stripComments(xml: string): string {
    return xml.replace(/<!--[\s\S]*?-->/g, '');
}

export function tagValue(xml: string, tag: string): string | undefined {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
    const match = re.exec(xml);
    if (!match) {
        return undefined;
    }
    const value = stripComments(match[1]).trim();
    return value.length > 0 ? value : undefined;
}

/** `<depend>`, `<build_depend>`, ... — everything that can pull in headers. */
export const DEPENDENCY_TAGS = [
    'depend',
    'build_depend',
    'build_export_depend',
    'exec_depend',
    'buildtool_depend',
    'buildtool_export_depend',
] as const;

/** Build tools that never contribute headers of their own. */
export const BUILD_TOOL_DEPENDENCIES = new Set([
    'ament_cmake',
    'ament_cmake_auto',
    'ament_cmake_gmock',
    'ament_cmake_gtest',
    'ament_cmake_pytest',
    'ament_cmake_ros',
    'ament_python',
    'ament_lint_auto',
    'ament_lint_common',
    'cmake',
    'rosidl_default_generators',
    'rosidl_default_runtime',
]);

export interface PackageManifest {
    name: string;
    buildType?: string;
    dependencies: string[];
}

/** Parse the pieces of a `package.xml` that matter for IntelliSense. */
export function parsePackageManifest(xml: string): PackageManifest | undefined {
    const clean = stripComments(xml);
    const name = tagValue(clean, 'name');
    if (!name) {
        return undefined;
    }

    const dependencies: string[] = [];
    const re = new RegExp(
        `<(${DEPENDENCY_TAGS.join('|')})(?:\\s[^>]*)?>([\\s\\S]*?)</\\1>`,
        'g',
    );
    let match: RegExpExecArray | null;
    while ((match = re.exec(clean)) !== null) {
        const dependency = match[2].trim();
        if (dependency) {
            dependencies.push(dependency);
        }
    }

    const buildType =
        tagValue(clean, 'build_type') ??
        dependencies.find(
            (dependency) =>
                dependency === 'ament_cmake' ||
                dependency === 'ament_python' ||
                dependency === 'cmake',
        );

    return {
        name,
        buildType,
        dependencies: dedupe(dependencies).filter((dependency) => dependency !== name),
    };
}

export interface CompileCommandEntry {
    directory?: string;
    file?: string;
    command?: string;
    arguments?: string[];
}

/** Split a shell command string into arguments, honouring simple quoting. */
export function tokenizeCommand(command: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | undefined;

    for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if (quote) {
            if (char === '\\' && quote === '"' && i + 1 < command.length) {
                current += command[++i];
            } else if (char === quote) {
                quote = undefined;
            } else {
                current += char;
            }
        } else if (char === '\\' && i + 1 < command.length) {
            // A backslash escapes the next character outside quotes too. This
            // matters for CMake's generated `-DNAME=\"value\"` defines: without
            // it the escaped quote would open a string and swallow every flag
            // that follows (losing include directories and other defines).
            const next = command[i + 1];
            if (next === '"' || next === "'" || next === '\\' || next === ' ') {
                current += command[++i];
            } else {
                // Keep Windows-style paths (`C:\foo`) intact.
                current += char;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === ' ' || char === '\t' || char === '\n') {
            if (current) {
                tokens.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }
    if (current) {
        tokens.push(current);
    }
    return tokens;
}

/** Include directories, `-D` defines and `-std` of a single compile command. */
export interface CompileCommandFlags {
    /** Absolute source file the entry applies to, when the database has one. */
    file?: string;
    includes: string[];
    defines: string[];
    /** Raw `-std=` value (e.g. `gnu++20`), normalised by {@link normalizeStandard}. */
    standard?: string;
}

function resolveAgainst(value: string, directory: string | undefined): string {
    const isAbsolute = value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
    return isAbsolute || !directory ? value : `${directory}/${value}`;
}

/**
 * Parse a compile_commands.json document into per-entry include directories and
 * `-D` defines. Commands may be given as `arguments` or as one `command` string;
 * relative paths are resolved against the entry's `directory`.
 */
export function compileCommandFlags(json: string): CompileCommandFlags[] {
    let entries: CompileCommandEntry[];
    try {
        const parsed: unknown = JSON.parse(json);
        entries = Array.isArray(parsed) ? (parsed as CompileCommandEntry[]) : [];
    } catch {
        return [];
    }

    const result: CompileCommandFlags[] = [];
    for (const entry of entries) {
        const args = entry.arguments ?? (entry.command ? tokenizeCommand(entry.command) : []);
        const includes: string[] = [];
        const defines: string[] = [];
        let standard: string | undefined;
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg === '-I' || arg === '-isystem' || arg === '-iquote' || arg === '-idirafter') {
                const value = args[++i];
                if (value) {
                    includes.push(resolveAgainst(value, entry.directory));
                }
            } else if (arg.startsWith('-isystem')) {
                const value = arg.slice('-isystem'.length);
                if (value) {
                    includes.push(resolveAgainst(value, entry.directory));
                }
            } else if (arg.startsWith('-I') && arg.length > 2) {
                includes.push(resolveAgainst(arg.slice(2), entry.directory));
            } else if (arg === '-D') {
                const value = args[++i];
                if (value) {
                    defines.push(value);
                }
            } else if (arg.startsWith('-D') && arg.length > 2) {
                defines.push(arg.slice(2));
            } else if (arg === '-std') {
                const value = args[++i];
                if (value) {
                    standard = value;
                }
            } else if (arg.startsWith('-std=') && arg.length > 5) {
                standard = arg.slice(5);
            } else if (arg.startsWith('/std:') && arg.length > 5) {
                // MSVC / clang-cl spelling.
                standard = arg.slice(5);
            }
        }
        result.push({
            file: entry.file ? resolveAgainst(entry.file, entry.directory) : undefined,
            includes: dedupe(includes),
            defines: dedupe(defines),
            standard,
        });
    }
    return result;
}

/**
 * Collect every include directory referenced by a compile_commands.json
 * document (the union across entries).
 */
export function includeDirectoriesFromCompileCommands(json: string): string[] {
    const includes = new Set<string>();
    for (const entry of compileCommandFlags(json)) {
        for (const include of entry.includes) {
            includes.add(include);
        }
    }
    return [...includes];
}

function normalizePath(value: string): string {
    const slashed = value.replace(/\\/g, '/');
    return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
}

/** The compile entry that builds `filePath`, if the database has one. */
export function compileEntryForFile(
    flags: CompileCommandFlags[],
    filePath: string,
): CompileCommandFlags | undefined {
    const target = normalizePath(filePath);
    for (const entry of flags) {
        if (entry.file && normalizePath(entry.file) === target) {
            return entry;
        }
    }
    return undefined;
}

/**
 * `-D` defines from the entry that compiles `filePath`. Empty when the database
 * has no entry for it (a header, or a build that has not run yet).
 */
export function definesForFile(flags: CompileCommandFlags[], filePath: string): string[] {
    return compileEntryForFile(flags, filePath)?.defines ?? [];
}

/** Old/alternative `-std` spellings that cpptools does not accept verbatim. */
const STANDARD_ALIASES: Record<string, string> = {
    'c++0x': 'c++11',
    'gnu++0x': 'gnu++11',
    'c++1y': 'c++14',
    'gnu++1y': 'gnu++14',
    'c++1z': 'c++17',
    'gnu++1z': 'gnu++17',
    'c++2a': 'c++20',
    'gnu++2a': 'gnu++20',
    'c++2b': 'c++23',
    'gnu++2b': 'gnu++23',
    'c++latest': 'c++23',
    c2x: 'c23',
    gnu2x: 'gnu23',
};

const C_STANDARD = /^(?:c|gnu)(?:89|99|11|17|23)$/;
const CPP_STANDARD = /^(?:c\+\+|gnu\+\+)(?:98|03|11|14|17|20|23)$/;

/**
 * Normalise a compiler `-std` value to one cpptools understands, or `undefined`
 * when it is not a C/C++ standard at all.
 */
export function normalizeStandard(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
        return undefined;
    }
    const mapped = STANDARD_ALIASES[trimmed] ?? trimmed;
    return C_STANDARD.test(mapped) || CPP_STANDARD.test(mapped) ? mapped : undefined;
}

/**
 * `-std` from the entry that compiles `filePath`, normalised. `undefined` when
 * the database has no entry or the flag is absent (callers fall back to
 * {@link defaultStandardFor}).
 */
export function standardForFile(
    flags: CompileCommandFlags[],
    filePath: string,
): string | undefined {
    return normalizeStandard(compileEntryForFile(flags, filePath)?.standard);
}

/**
 * Standard to use when the compile database has no `-std` for the file: the
 * compiler defaults (gnu17 for C, gnu++17 for C++). Headers are treated as C++
 * because a `.h` is far more often part of a C++ package than a C one.
 */
export function defaultStandardFor(filePath: string): string {
    return /\.c$/i.test(filePath) ? 'gnu17' : 'gnu++17';
}

/** POSIX single-quote a value for safe interpolation into a shell command. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
