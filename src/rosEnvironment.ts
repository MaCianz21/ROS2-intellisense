/**
 * ROS 2 installation discovery.
 *
 * ROS 2 is not always installed under `/opt/ros`: RoboStack/Pixi environments,
 * Docker images and source builds keep it under arbitrary prefixes. The
 * authoritative hint is the environment (`AMENT_PREFIX_PATH`,
 * `COLCON_PREFIX_PATH`, `CONDA_PREFIX`, `ROS_DISTRO`), with `/opt/ros` only as a
 * fallback. This module has no `vscode` import so it can be unit-tested with
 * plain Node.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface RosInstall {
    /** Install prefix, e.g. `/opt/ros/jazzy` or a RoboStack/conda environment. */
    readonly prefix: string;
    /** `ROS_DISTRO` reported by that prefix (`jazzy`, `humble`, …). */
    readonly distro: string;
}

export interface RosInstallOptions {
    /** Explicit prefix (`ros2IntelliSense.rosPrefix`), highest priority. */
    configuredPrefix?: string;
    /** Explicit distro (`ros2IntelliSense.rosDistro`). */
    configuredDistro?: string;
    /** Contents of `.ros-intellisense.env`, when the workspace has one. */
    envFileContents?: string;
    /** Extra prefixes to probe before the environment and `/opt/ros`. */
    extraPrefixes?: string[];
    /** Overridable for tests. Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
}

const DISTRO_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** `ros_environment` lookups are repeated for every prefix in `AMENT_PREFIX_PATH`. */
const distroCache = new Map<string, string | undefined>();

function normalizeDir(value: string): string {
    const resolved = path.resolve(value);
    return resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved;
}

/** Platform default install root. Windows native is out of scope, but harmless. */
function defaultRosRoot(): string {
    return process.platform === 'win32' ? 'C:\\opt\\ros' : '/opt/ros';
}

/**
 * `ROS_DISTRO` declared by a ROS install prefix, or `undefined` when the
 * directory is not a ROS installation.
 *
 * `ros_environment` is part of every ROS 2 install but not of a plain workspace
 * overlay, so this also tells a distro prefix apart from `install/` directories
 * found in `AMENT_PREFIX_PATH`.
 */
export function rosDistroInPrefix(prefix: string): string | undefined {
    const normalized = normalizeDir(prefix);
    if (distroCache.has(normalized)) {
        return distroCache.get(normalized);
    }

    let distro: string | undefined;
    // Cheap guard: `AMENT_PREFIX_PATH` is mostly workspace `install/` dirs.
    if (fs.existsSync(path.join(normalized, 'share', 'ros_environment'))) {
        for (const relative of [
            path.join('share', 'ros_environment', 'environment', '1.ros_distro.dsv'),
            path.join('share', 'ros_environment', 'environment', '1.ros_distro.sh'),
        ]) {
            try {
                const text = fs.readFileSync(path.join(normalized, relative), 'utf8');
                // `.dsv`: `set;ROS_DISTRO;jazzy` — `.sh`: `export ROS_DISTRO=jazzy`.
                const match = /ROS_DISTRO\s*[;=]\s*["']?([A-Za-z0-9_]+)/.exec(text);
                if (match) {
                    distro = match[1];
                    break;
                }
            } catch {
                // Not this file; try the next representation.
            }
        }
    }

    distroCache.set(normalized, distro);
    return distro;
}

/**
 * True when `filePath` is a header inside a ROS installation's `include/`
 * directory. Used to give ROS headers opened via go-to-definition the same
 * configuration as the workspace file that includes them.
 */
export function isRosHeaderPath(filePath: string, prefix: string): boolean {
    if (!prefix) {
        return false;
    }
    const includeRoot = path.join(normalizeDir(prefix), 'include');
    return filePath.startsWith(`${includeRoot}${path.sep}`);
}

function splitPathList(value: string | undefined): string[] {
    if (!value) {
        return [];
    }
    return value
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

/** Distro prefixes under the platform default root, newest first. */
function systemRosPrefixes(): string[] {
    const root = defaultRosRoot();
    try {
        return fs
            .readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(root, entry.name))
            .sort((a, b) =>
                path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }),
            );
    } catch {
        return [];
    }
}

/**
 * Every usable ROS 2 installation, most authoritative first:
 * explicit prefix, sourced environment, conda env, then `/opt/ros` (newest).
 */
export function discoverRosInstalls(options: RosInstallOptions = {}): RosInstall[] {
    const env = options.env ?? process.env;
    const candidates = [
        ...(options.extraPrefixes ?? []),
        ...splitPathList(env.AMENT_PREFIX_PATH),
        ...splitPathList(env.COLCON_PREFIX_PATH),
        env.CONDA_PREFIX ?? '',
        ...systemRosPrefixes(),
    ];

    const installs: RosInstall[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }
        const prefix = normalizeDir(candidate);
        if (seen.has(prefix)) {
            continue;
        }
        const distro = rosDistroInPrefix(prefix);
        if (!distro || !DISTRO_RE.test(distro)) {
            continue;
        }
        seen.add(prefix);
        installs.push({ prefix, distro });
    }
    return installs;
}

function distroFromEnvFile(contents: string | undefined): string | undefined {
    if (!contents) {
        return undefined;
    }
    const match = /^\s*ROS_DISTRO\s*=\s*(.+?)\s*$/m.exec(contents);
    return match?.[1].replace(/^['"]|['"]$/g, '');
}

/**
 * Pick the ROS installation for a workspace.
 *
 * Precedence: configured prefix → configured distro → `ROS_DISTRO` /
 * `.ros-intellisense.env` → the first sourced install → the newest `/opt/ros`.
 * Returns `undefined` when no installation can be found at all, instead of
 * silently pretending a distro exists.
 */
export function resolveRosInstall(options: RosInstallOptions = {}): RosInstall | undefined {
    const env = options.env ?? process.env;

    const configuredPrefix = options.configuredPrefix?.trim();
    if (configuredPrefix) {
        const prefix = normalizeDir(configuredPrefix);
        const fromPrefix = rosDistroInPrefix(prefix);
        if (fromPrefix) {
            return { prefix, distro: fromPrefix };
        }
        // A minimal install may lack `ros_environment`: accept it when it has a
        // setup script, or when the distro is configured explicitly.
        const hasSetupScript =
            fs.existsSync(path.join(prefix, 'setup.bash')) ||
            fs.existsSync(path.join(prefix, 'local_setup.bash'));
        const explicitDistro = options.configuredDistro?.trim();
        if (hasSetupScript && explicitDistro) {
            return { prefix, distro: explicitDistro };
        }
        if (hasSetupScript) {
            return { prefix, distro: path.basename(prefix) };
        }
        if (explicitDistro) {
            return { prefix, distro: explicitDistro };
        }
        // Neither a ROS prefix nor a distro hint: ignore it and keep discovering.
    }

    const installs = discoverRosInstalls(options);
    const configuredDistro = options.configuredDistro?.trim();
    const wanted =
        configuredDistro || env.ROS_DISTRO?.trim() || distroFromEnvFile(options.envFileContents);
    if (wanted) {
        const match = installs.find((install) => install.distro === wanted);
        if (match) {
            return match;
        }
        // An explicitly configured distro is authoritative even when its prefix
        // was not discovered (custom location): keep the conventional path so
        // include roots and the build script still have somewhere to point.
        if (configuredDistro) {
            return { prefix: path.join(defaultRosRoot(), wanted), distro: wanted };
        }
    }

    return installs[0];
}
