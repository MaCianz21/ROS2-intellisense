import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BUILD_TOOL_DEPENDENCIES, parsePackageManifest } from './parse';
import { RosWorkspace } from './rosWorkspace';
import { log } from './util';

export interface RosPackage {
    readonly name: string;
    /** Absolute path of the package root (the directory containing package.xml). */
    readonly dir: string;
    readonly manifest: string;
    readonly buildType?: string;
    readonly dependencies: string[];
}

function readPackage(manifestPath: string): RosPackage | undefined {
    try {
        const manifest = parsePackageManifest(fs.readFileSync(manifestPath, 'utf8'));
        if (!manifest) {
            return undefined;
        }
        return {
            name: manifest.name,
            dir: path.dirname(manifestPath),
            manifest: manifestPath,
            buildType: manifest.buildType,
            dependencies: manifest.dependencies.filter(
                (dependency) => !BUILD_TOOL_DEPENDENCIES.has(dependency),
            ),
        };
    } catch (error) {
        log(`Failed to read package manifest ${manifestPath}: ${String(error)}`);
        return undefined;
    }
}

/**
 * Resolves the package that owns a file by walking up to the nearest
 * `package.xml`. Results (including "no package here") are cached per directory,
 * so this is a handful of cached `stat` calls even for large workspaces — no
 * workspace-wide scan happens at startup.
 */
export class PackageLocator {
    private readonly cache = new Map<string, RosPackage | null>();

    constructor(private readonly workspace: RosWorkspace) {}

    clear(): void {
        this.cache.clear();
    }

    owning(filePath: string): RosPackage | undefined {
        const root = path.resolve(this.workspace.root);
        let dir = path.dirname(path.resolve(filePath));

        while (dir.startsWith(root)) {
            const cached = this.cache.get(dir);
            if (cached !== undefined) {
                if (cached) {
                    return cached;
                }
            } else {
                const manifest = path.join(dir, 'package.xml');
                const pkg = fs.existsSync(manifest) ? readPackage(manifest) ?? null : null;
                this.cache.set(dir, pkg);
                if (pkg) {
                    return pkg;
                }
            }

            const parent = path.dirname(dir);
            if (parent === dir) {
                break;
            }
            dir = parent;
        }
        return undefined;
    }
}

/**
 * Full workspace scan of every `package.xml`. Only used by interactive commands
 * (e.g. the package picker), never during activation.
 */
export async function discoverPackages(workspace: RosWorkspace): Promise<RosPackage[]> {
    const exclude = '**/{build,install,log,node_modules,.git}/**';
    const base = vscode.Uri.file(workspace.root);
    let manifests = await vscode.workspace.findFiles(
        new vscode.RelativePattern(base, '**/package.xml'),
        exclude,
        5000,
    );
    if (manifests.length === 0) {
        // Workspaces that keep packages directly under the root.
        manifests = await vscode.workspace.findFiles(
            new vscode.RelativePattern(base, '*/package.xml'),
            undefined,
            2000,
        );
    }
    // A repo that is the package itself: `package.xml` at the workspace root.
    // Some VS Code glob implementations do not return the base file for `**`.
    const rootManifest = vscode.Uri.file(path.join(workspace.root, 'package.xml'));
    if (
        fs.existsSync(rootManifest.fsPath) &&
        !manifests.some((manifest) => manifest.fsPath === rootManifest.fsPath)
    ) {
        manifests = [rootManifest, ...manifests];
    }

    const packages = new Map<string, RosPackage>();
    for (const uri of manifests) {
        const pkg = readPackage(uri.fsPath);
        if (pkg) {
            packages.set(pkg.name, pkg);
        }
    }
    log(`Discovered ${packages.size} ROS package(s) under ${workspace.root}`);
    return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
}
