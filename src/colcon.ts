import * as fs from 'fs';
import * as path from 'path';

/**
 * Workspace discovery helpers. Deliberately free of `vscode` imports so they
 * can be exercised by the plain-Node unit tests.
 */

/** Directories that never contain a nested workspace worth descending into. */
const NON_WORKSPACE_DIRS = new Set(['build', 'install', 'log', '.git', 'node_modules', '.vscode']);

function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}

function isFile(target: string): boolean {
    try {
        return fs.statSync(target).isFile();
    } catch {
        return false;
    }
}

/** True when a `package.xml` exists at `dir` or within `depth` levels below it. */
function hasPackageBelow(dir: string, depth: number): boolean {
    if (isFile(path.join(dir, 'COLCON_IGNORE'))) {
        return false;
    }
    if (isFile(path.join(dir, 'package.xml'))) {
        return true;
    }
    if (depth <= 0) {
        return false;
    }
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || NON_WORKSPACE_DIRS.has(entry.name)) {
                continue;
            }
            if (hasPackageBelow(path.join(dir, entry.name), depth - 1)) {
                return true;
            }
        }
    } catch {
        // Unreadable directory: nothing below it.
    }
    return false;
}

/**
 * True when `dir` looks like a colcon workspace root.
 *
 * A workspace root never holds a `package.xml` itself (packages live in `src/`
 * or directly underneath), so that is used to reject package directories that
 * happen to contain stray `build/`/`install/` folders. `install/` must be a real
 * directory (some packages ship an executable named `install`), with the
 * `build/` + `log/` pair as a fallback for workspaces that were configured but
 * not yet installed.
 */
export function isColconRoot(dir: string): boolean {
    if (isFile(path.join(dir, 'package.xml'))) {
        return false;
    }
    if (isDirectory(path.join(dir, 'install'))) {
        return true;
    }
    return isDirectory(path.join(dir, 'build')) && isDirectory(path.join(dir, 'log'));
}

/**
 * True when `dir` is a ROS 2 workspace root even before it has been built.
 *
 * This covers the layouts that do not look like a classic colcon workspace:
 * the repo is the package itself (`package.xml` at the root), the repo keeps
 * packages directly under the root (no `src/`), or the repo has a `src/`
 * directory but no `build/`/`install/` yet. Only one directory level is read, so
 * activation stays cheap.
 */
export function looksLikeRosWorkspace(dir: string): boolean {
    if (isFile(path.join(dir, 'COLCON_IGNORE'))) {
        return false;
    }
    if (hasPackageBelow(dir, 1)) {
        return true;
    }
    // Classic colcon layout, even before the first build or before packages
    // have been added to `src/`.
    return isDirectory(path.join(dir, 'src'));
}

/**
 * A nested workspace candidate for discovery. Unlike {@link looksLikeRosWorkspace},
 * a bare `src/` is not enough: it must actually contain a package, otherwise a
 * generic project checked into the opened folder would be treated as ROS.
 */
function isRosWorkspaceCandidate(dir: string): boolean {
    if (isFile(path.join(dir, 'COLCON_IGNORE'))) {
        return false;
    }
    if (isColconRoot(dir) || hasPackageBelow(dir, 1)) {
        return true;
    }
    const srcDir = path.join(dir, 'src');
    return isDirectory(srcDir) && hasPackageBelow(srcDir, 2);
}

/**
 * Browse (`browse.path`) entries for a workspace.
 *
 * `src/**` and `include/**` cover the usual `src/<pkg>` and package-at-root
 * layouts. Repos that keep packages directly under the root contribute their
 * own `src/**` and `include/**`. `build/`, `install/` and `log/` are never
 * included, so symbol search stays limited to actual source code.
 */
export function workspaceBrowsePaths(root: string): string[] {
    if (isFile(path.join(root, 'COLCON_IGNORE'))) {
        return [];
    }
    const paths: string[] = [];
    const add = (value: string): void => {
        if (!paths.includes(value)) {
            paths.push(value);
        }
    };

    if (isDirectory(path.join(root, 'src'))) {
        add(`${root}/src/**`);
    }
    if (isDirectory(path.join(root, 'include'))) {
        add(`${root}/include/**`);
    }

    try {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || NON_WORKSPACE_DIRS.has(entry.name)) {
                continue;
            }
            const child = path.join(root, entry.name);
            if (isFile(path.join(child, 'COLCON_IGNORE'))) {
                continue;
            }
            if (!isFile(path.join(child, 'package.xml'))) {
                continue;
            }
            if (isDirectory(path.join(child, 'src'))) {
                add(`${child}/src/**`);
            }
            if (isDirectory(path.join(child, 'include'))) {
                add(`${child}/include/**`);
            }
        }
    } catch {
        // Ignore unreadable directories.
    }

    return paths;
}

/**
 * Find ROS workspace roots nested *inside* `root` (not `root` itself).
 *
 * Covers colcon workspaces (`install/`, or `build/` + `log/`), unbuilt
 * workspaces that only have `src/`, and repos that keep packages directly under
 * a subdirectory. The walk is bounded in depth and prunes `build/`, `install/`,
 * `log/`, `node_modules`, dot-directories and ROS package directories, so it
 * stays cheap.
 */
export function discoverNestedWorkspaces(root: string, maxDepth = 3): string[] {
    if (isFile(path.join(root, 'COLCON_IGNORE'))) {
        return [];
    }
    const found: string[] = [];
    const rootIsWorkspace = isColconRoot(root) || looksLikeRosWorkspace(root);

    const visit = (dir: string, depth: number, parentIsWorkspace: boolean): void => {
        if (depth > maxDepth) {
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || NON_WORKSPACE_DIRS.has(entry.name)) {
                continue;
            }
            // The `src/` of a workspace is a source container, not another
            // workspace. Without this, every `<ws>/src` would be mistaken for
            // a package container because its children have `package.xml`.
            if (parentIsWorkspace && entry.name === 'src') {
                continue;
            }
            const child = path.join(dir, entry.name);
            if (isFile(path.join(child, 'package.xml'))) {
                // A ROS package, never a workspace container.
                continue;
            }
            if (isRosWorkspaceCandidate(child)) {
                found.push(child);
                // A workspace is a leaf for discovery: its `src/` is covered by
                // the workspace itself.
                continue;
            }
            visit(child, depth + 1, false);
        }
    };

    visit(root, 1, rootIsWorkspace);
    return found;
}
