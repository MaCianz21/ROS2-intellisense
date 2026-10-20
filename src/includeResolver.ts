import * as fs from 'fs';
import * as path from 'path';
import type { RosPackage } from './rosPackage';
import type { RosWorkspace } from './rosWorkspace';

export type IncludeMode = 'package' | 'workspace';

export interface IncludePathPlanOptions {
    mode: IncludeMode;
    /** Exact `-I` / `-isystem` directories recovered from compile_commands.json. */
    compileIncludes: string[];
    extraIncludePaths: string[];
    /**
     * Non-recursive include roots for the ROS installation (the base `include`
     * directory plus one entry per installed package, see
     * {@link rosPackageIncludeRoots}). Left optional so the planner stays pure
     * and can be unit-tested without touching a real ROS install.
     */
    rosIncludeRoots?: string[];
    /**
     * Include roots of declared dependencies that live in the same workspace,
     * used before they are installed (e.g. `<ws>/src/my_msgs/include`). Only
     * ROS-layout roots are supplied by the caller, so they cannot shadow system
     * headers.
     */
    siblingIncludes?: string[];
}

const rosIncludeRootsCache = new Map<string, string[]>();

/**
 * Non-recursive include roots for a ROS installation: the `include` directory
 * itself (a few packages drop loose headers straight there) followed by one root
 * per installed package directory.
 *
 * This matters because ROS headers are always addressed with their package
 * prefix (`#include <rclcpp/rclcpp.hpp>` or `#include <geometry_msgs/msg/twist.hpp>`),
 * and the on-disk layout is `include/<pkg>/<pkg>/...`. The resolvable root is
 * therefore `include/<pkg>`, not `include`. Enumerated at most once per install
 * prefix and cached; the directory listing is cheap (a single `readdir`).
 *
 * `prefix` is the ROS install prefix (`/opt/ros/jazzy`, a RoboStack/conda
 * environment, …), so non-apt installations work too.
 *
 * Only directories that follow that layout — i.e. that contain a nested
 * `<pkg>/` of the same name — are exposed as roots. Plenty of packages
 * (debian/3rd-party bundles like `lely`, `osqp`, `ouster`, `depthai`,
 * `ur_client_library`, …) instead drop loose headers into `include/<pkg>/`.
 * Making such a directory a root would surface those files at the top level and
 * shadow system headers: `lely/features.h` would win over glibc's
 * `<features.h>` and break `<c++config.h>` — which takes all of libstdc++ down
 * with it. See the regression note in `CHANGELOG.md`.
 */
export function rosPackageIncludeRoots(prefix: string): string[] {
    if (!prefix) {
        return [];
    }
    const cached = rosIncludeRootsCache.get(prefix);
    if (cached) {
        return cached;
    }
    const roots = packageIncludeRootsIn(path.join(prefix, 'include'));
    rosIncludeRootsCache.set(prefix, roots);
    return roots;
}

/**
 * The roots themselves, given a ROS `include` directory (kept separate from the
 * per-distro cache so it can be unit-tested against a temporary directory —
 * the same reason {@link rosPackageIncludeRoots} exists at all).
 */
export function packageIncludeRootsIn(base: string): string[] {
    const roots: string[] = [base];
    try {
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const dir = path.join(base, entry.name);
            if (followsRosLayout(dir, entry.name)) {
                roots.push(dir);
            }
        }
    } catch {
        // Distro not installed here (for example on CI): keep just the base path.
    }
    return roots;
}

/**
 * True when `dir` looks like a ROS package include root: it contains a nested
 * directory named after the package (`include/<pkg>/<pkg>/...`). Directories
 * that do not (third-party bundles with loose headers) are deliberately not
 * used as roots, so they cannot shadow system headers. See
 * {@link rosPackageIncludeRoots}.
 */
function followsRosLayout(dir: string, name: string): boolean {
    try {
        return fs.statSync(path.join(dir, name)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Pure planner for the IntelliSense include path.
 *
 * Returns **concrete, non-recursive** directories only. ROS headers are always
 * addressed with their package prefix (`#include <rclcpp/rclcpp.hpp>`), so a
 * non-recursive per-package include root already resolves them — appending
 * `/**` would only make the C/C++ engine walk and watch far more of the
 * filesystem for no gain. See {@link rosPackageIncludeRoots}.
 *
 * This module has no `vscode` import and is covered by unit tests.
 */
export function planIncludePaths(
    workspace: RosWorkspace,
    pkg: RosPackage | undefined,
    options: IncludePathPlanOptions,
): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const add = (value: string | undefined): void => {
        if (value && !seen.has(value)) {
            seen.add(value);
            result.push(value);
        }
    };

    if (pkg) {
        // The active package's own headers, addressed as <pkgname/...>.
        add(path.join(pkg.dir, 'include'));
        // What the active package installed (rosidl-generated code, ...).
        add(path.join(workspace.installDir, pkg.name, 'include'));
        // Direct dependencies from the install space.
        for (const dependency of pkg.dependencies) {
            add(path.join(workspace.installDir, dependency, 'include'));
        }
    }

    add(path.join(workspace.installDir, 'include'));
    // Source dependencies of the same workspace: available before the first
    // build, so sibling headers resolve without running colcon. Generated
    // interfaces still need a build (their headers do not exist yet).
    for (const include of options.siblingIncludes ?? []) {
        add(include);
    }
    // Fallback for callers that predate `rosPrefix`: the conventional apt path.
    const rosPrefix =
        workspace.rosPrefix || (workspace.distro ? path.join('/opt/ros', workspace.distro) : '');
    if (rosPrefix) {
        add(path.join(rosPrefix, 'include'));
    }
    // One non-recursive root per installed ROS package, so `<pkg>/...` includes
    // resolve even before the workspace has been built.
    for (const root of options.rosIncludeRoots ?? []) {
        add(root);
    }

    for (const include of options.compileIncludes) {
        add(include);
    }
    for (const extra of options.extraIncludePaths) {
        add(extra.replace(/\$\{workspaceFolder\}/g, workspace.root));
    }

    // Opt-in only: the broad recursive scan.
    if (options.mode === 'workspace') {
        add(`${workspace.root}/**`);
    }

    return result;
}

/**
 * Same as {@link planIncludePaths}, but drops directories that do not exist so
 * the list handed to the C/C++ engine stays as small as possible.
 */
export function resolveIncludePaths(
    workspace: RosWorkspace,
    pkg: RosPackage | undefined,
    options: IncludePathPlanOptions,
): string[] {
    return planIncludePaths(workspace, pkg, options).filter((dir) => {
        if (dir.endsWith('/**')) {
            // A glob cannot be stat-ed; it is only produced in `workspace` mode.
            return true;
        }
        try {
            return fs.existsSync(dir);
        } catch {
            return false;
        }
    });
}
