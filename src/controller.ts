import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_SECTION } from './constants';
import { discoverNestedWorkspaces } from './colcon';
import { IncludeMode, resolveIncludePaths, rosPackageIncludeRoots } from './includeResolver';
import { compileCommandFlags, CompileCommandFlags, definesForFile, standardForFile } from './parse';
import { isRosHeaderPath } from './rosEnvironment';
import { discoverPackages, PackageLocator, RosPackage } from './rosPackage';
import { loadWorkspace, RosWorkspace } from './rosWorkspace';

/**
 * Owns all ROS state for the current VS Code window.
 *
 * Deliberately lazy and event-driven:
 *  - activation only stats the workspace folders; it never scans packages,
 *  - the owning package of a file is found by walking up the tree (cached),
 *  - compile_commands.json is parsed once, in the background, and only re-read
 *    when its mtime changes,
 *  - include paths are cached per package and invalidated on change.
 */
export class RosController implements vscode.Disposable {
    readonly onDidUpdate = new vscode.EventEmitter<void>();
    readonly workspaces: RosWorkspace[] = [];

    private readonly locators = new Map<string, PackageLocator>();
    private readonly packageLists = new Map<string, RosPackage[]>();
    private readonly compileIncludes = new Map<string, string[]>();
    private readonly compileFlags = new Map<string, CompileCommandFlags[]>();
    private readonly compileSignatures = new Map<string, string>();
    private readonly includeCache = new Map<string, string[]>();
    private readonly activeByName = new Map<string, RosPackage | undefined>();
    private activeFile: string | undefined;

    async initialize(): Promise<void> {
        this.workspaces.length = 0;
        this.locators.clear();
        this.packageLists.clear();
        this.compileIncludes.clear();
        this.compileFlags.clear();
        this.compileSignatures.clear();
        this.includeCache.clear();
        this.activeByName.clear();

        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const own = await loadWorkspace(folder);
            if (own) {
                this.addWorkspace(own);
            }
            // The opened folder is not always the colcon root: workspaces are
            // sometimes nested (e.g. <repo>/mobile/ with its own build/install).
            for (const nestedRoot of discoverNestedWorkspaces(folder.uri.fsPath)) {
                if (own && nestedRoot === own.root) {
                    continue;
                }
                const nested = await loadWorkspace(folder, nestedRoot);
                if (nested) {
                    this.addWorkspace(nested);
                }
            }
        }

        this.refreshActivePackage();
        this.onDidUpdate.fire();

        // Parsing the compile database can be expensive; do it off the critical path.
        void this.reloadCompileIncludes();
    }

    dispose(): void {
        this.onDidUpdate.dispose();
    }

    private addWorkspace(workspace: RosWorkspace): void {
        if (this.workspaces.some((candidate) => candidate.root === workspace.root)) {
            return;
        }
        this.workspaces.push(workspace);
        this.locators.set(workspace.root, new PackageLocator(workspace));
    }

    workspaceFor(uri: vscode.Uri): RosWorkspace | undefined {
        return uri.scheme === 'file' ? this.workspaceForPath(uri.fsPath) : undefined;
    }

    /**
     * Workspace whose configuration should be used for `uri`.
     *
     * Normally this is the nearest enclosing workspace. Headers under the ROS
     * installation (`<prefix>/include/...`) are outside every workspace root,
     * but they still need the full per-package ROS include path when the user
     * opens one with go-to-definition; otherwise cpptools falls back to a
     * minimal `c_cpp_properties.json` and the header reports missing includes.
     */
    configurationWorkspaceFor(uri: vscode.Uri): RosWorkspace | undefined {
        return uri.scheme === 'file' ? this.configurationWorkspaceForPath(uri.fsPath) : undefined;
    }

    activePackage(workspace: RosWorkspace): RosPackage | undefined {
        return this.activeByName.get(workspace.root);
    }

    packageForFile(filePath: string): RosPackage | undefined {
        const workspace = this.workspaceForPath(filePath);
        if (!workspace) {
            return undefined;
        }
        return this.locators.get(workspace.root)?.owning(filePath);
    }

    includePathsFor(workspace: RosWorkspace, pkg: RosPackage | undefined): string[] {
        const key = `${workspace.root}\u0000${pkg?.name ?? ''}`;
        const cached = this.includeCache.get(key);
        if (cached) {
            return cached;
        }

        const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const paths = resolveIncludePaths(workspace, pkg, {
            mode: configuration.get<IncludeMode>('includeMode', 'package'),
            compileIncludes: this.compileIncludes.get(workspace.root) ?? [],
            extraIncludePaths: configuration.get<string[]>('extraIncludePaths', []),
            rosIncludeRoots: rosPackageIncludeRoots(workspace.rosPrefix),
            siblingIncludes: this.siblingIncludesFor(workspace, pkg),
        });
        this.includeCache.set(key, paths);
        return paths;
    }

    /**
     * Include roots of declared dependencies that live in this workspace.
     *
     * Before a build, `<ws>/src/<dep>/include` and `<repo>/<dep>/include` do not
     * exist in `install/`, so sibling headers would only resolve after a full
     * colcon build. Only ROS-layout roots (`<dep>/include/<dep>/...`) are used,
     * so a dependency cannot surface loose headers that shadow system headers.
     * Generated interfaces still require a build.
     */
    private siblingIncludesFor(workspace: RosWorkspace, pkg: RosPackage | undefined): string[] {
        if (!pkg) {
            return [];
        }
        const result: string[] = [];
        for (const dependency of pkg.dependencies) {
            for (const base of [workspace.srcDir, workspace.root]) {
                const include = path.join(base, dependency, 'include');
                if (this.isRosLayoutInclude(include, dependency) && !result.includes(include)) {
                    result.push(include);
                }
            }
        }
        return result;
    }

    private isRosLayoutInclude(includeDir: string, packageName: string): boolean {
        try {
            return fs.statSync(path.join(includeDir, packageName)).isDirectory();
        } catch {
            return false;
        }
    }

    /** `-D` defines from the real build entry for `filePath` (empty for headers). */
    definesForPath(filePath: string): string[] {
        const workspace = this.workspaceForPath(filePath);
        if (!workspace) {
            return [];
        }
        const flags = this.compileFlags.get(workspace.root);
        return flags ? definesForFile(flags, filePath) : [];
    }

    /** `-std` from the real build entry for `filePath`, when it has one. */
    standardForPath(filePath: string): string | undefined {
        const workspace = this.workspaceForPath(filePath);
        if (!workspace) {
            return undefined;
        }
        const flags = this.compileFlags.get(workspace.root);
        return flags ? standardForFile(flags, filePath) : undefined;
    }

    /** Full package list for interactive commands. Scanned on first use, then cached. */
    async discoverPackages(workspace: RosWorkspace): Promise<RosPackage[]> {
        const cached = this.packageLists.get(workspace.root);
        if (cached) {
            return cached;
        }
        const packages = await discoverPackages(workspace);
        this.packageLists.set(workspace.root, packages);
        return packages;
    }

    setActiveEditor(editor: vscode.TextEditor | undefined): void {
        const fsPath =
            editor && editor.document.uri.scheme === 'file' ? editor.document.uri.fsPath : undefined;
        if (fsPath === this.activeFile) {
            return;
        }
        this.activeFile = fsPath;
        this.refreshActivePackage();
        this.onDidUpdate.fire();
    }

    /** Re-read compile_commands.json when it changed. Returns `true` if it did. */
    async reloadCompileIncludes(): Promise<boolean> {
        let changed = false;
        for (const workspace of this.workspaces) {
            changed = (await this.loadCompileIncludes(workspace)) || changed;
        }
        if (changed) {
            this.includeCache.clear();
            this.onDidUpdate.fire();
        }
        return changed;
    }

    /** Cheap refresh: drop caches and re-detect the active package. */
    async refreshAll(): Promise<void> {
        for (const locator of this.locators.values()) {
            locator.clear();
        }
        this.packageLists.clear();
        this.includeCache.clear();
        await this.reloadCompileIncludes();
        this.refreshActivePackage();
        this.onDidUpdate.fire();
    }

    /**
     * Nearest enclosing ROS workspace (longest matching root), supporting nested
     * roots. This is the workspace that owns a file for the active-package UI.
     */
    private workspaceForPath(filePath: string): RosWorkspace | undefined {
        let best: RosWorkspace | undefined;
        for (const workspace of this.workspaces) {
            const { root } = workspace;
            if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
                continue;
            }
            if (!best || root.length > best.root.length) {
                best = workspace;
            }
        }
        return best;
    }

    /**
     * Workspace configuration for a file, including ROS-install headers that
     * live outside every workspace root. The longest matching ROS prefix wins
     * when several distros are open in the same window.
     */
    private configurationWorkspaceForPath(filePath: string): RosWorkspace | undefined {
        const own = this.workspaceForPath(filePath);
        if (own) {
            return own;
        }
        let best: RosWorkspace | undefined;
        for (const workspace of this.workspaces) {
            if (!isRosHeaderPath(filePath, workspace.rosPrefix)) {
                continue;
            }
            if (!best || workspace.rosPrefix.length > best.rosPrefix.length) {
                best = workspace;
            }
        }
        return best;
    }

    private refreshActivePackage(): void {
        if (!this.activeFile) {
            return;
        }
        const workspace = this.workspaceForPath(this.activeFile);
        if (!workspace) {
            // Opening a ROS header or a non-source file must not clear the
            // package shown for the workspace the user is working in.
            return;
        }
        for (const candidate of this.workspaces) {
            this.activeByName.set(
                candidate.root,
                candidate.root === workspace.root
                    ? this.locators.get(candidate.root)?.owning(this.activeFile)
                    : undefined,
            );
        }
    }

    private async loadCompileIncludes(workspace: RosWorkspace): Promise<boolean> {
        const sources = await this.compileDatabaseSources(workspace);
        if (sources.length === 0) {
            return this.clearCompileDatabase(workspace);
        }

        const signature = sources
            .map((source) => `${source.path}:${source.mtimeMs}:${source.size}`)
            .join('|');
        if (this.compileSignatures.get(workspace.root) === signature) {
            return false;
        }

        try {
            const flags: CompileCommandFlags[] = [];
            const includes = new Set<string>();
            for (const source of sources) {
                const contents = await fs.promises.readFile(source.path, 'utf8');
                for (const entry of compileCommandFlags(contents)) {
                    flags.push(entry);
                    for (const include of entry.includes) {
                        includes.add(include);
                    }
                }
            }

            this.compileFlags.set(workspace.root, flags);
            this.compileIncludes.set(workspace.root, [...includes]);
            this.compileSignatures.set(workspace.root, signature);
            return true;
        } catch {
            return this.clearCompileDatabase(workspace);
        }
    }

    private clearCompileDatabase(workspace: RosWorkspace): boolean {
        const hadFlags = this.compileFlags.delete(workspace.root);
        const hadIncludes = this.compileIncludes.delete(workspace.root);
        const hadSignature = this.compileSignatures.delete(workspace.root);
        return hadFlags || hadIncludes || hadSignature;
    }

    /**
     * Prefer the merged `build/compile_commands.json` when it is up to date.
     * After a terminal build, only `build/<pkg>/compile_commands.json` files are
     * written; fold those in so IntelliSense sees the new flags without the
     * "Merge compile_commands.json" command.
     */
    private async compileDatabaseSources(workspace: RosWorkspace): Promise<CompileDatabaseSource[]> {
        const merged = await this.statOrUndefined(workspace.mergeFile);
        const perPackage = await this.perPackageCompileDatabases(workspace);
        const newestPerPackage = perPackage.reduce(
            (newest, source) => Math.max(newest, source.mtimeMs),
            0,
        );
        if (merged && (perPackage.length === 0 || merged.mtimeMs >= newestPerPackage)) {
            return [merged];
        }
        return perPackage.length > 0 ? perPackage : merged ? [merged] : [];
    }

    private async perPackageCompileDatabases(
        workspace: RosWorkspace,
    ): Promise<CompileDatabaseSource[]> {
        let children: fs.Dirent[];
        try {
            children = await fs.promises.readdir(workspace.buildDir, { withFileTypes: true });
        } catch {
            return [];
        }
        const sources: CompileDatabaseSource[] = [];
        for (const child of children) {
            if (!child.isDirectory()) {
                continue;
            }
            const file = path.join(workspace.buildDir, child.name, 'compile_commands.json');
            const source = await this.statOrUndefined(file);
            if (source) {
                sources.push(source);
            }
        }
        return sources;
    }

    private async statOrUndefined(file: string): Promise<CompileDatabaseSource | undefined> {
        try {
            const stat = await fs.promises.stat(file);
            return stat.isFile()
                ? { path: file, mtimeMs: stat.mtimeMs, size: stat.size }
                : undefined;
        } catch {
            return undefined;
        }
    }
}

interface CompileDatabaseSource {
    path: string;
    mtimeMs: number;
    size: number;
}
