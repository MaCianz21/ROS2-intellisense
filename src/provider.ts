import * as path from 'path';
import * as vscode from 'vscode';
import { workspaceBrowsePaths } from './colcon';
import { CONFIG_SECTION, EXTENSION_ID, PROVIDER_NAME } from './constants';
import { RosController } from './controller';
import {
    CustomConfigurationProvider,
    SourceFileConfiguration,
    SourceFileConfigurationItem,
    WorkspaceBrowseConfiguration,
} from './cpptools';
import { defaultStandardFor } from './parse';
import { RosWorkspace } from './rosWorkspace';

const SOURCE_EXTENSIONS = [
    '.c',
    '.cc',
    '.cpp',
    '.cxx',
    '.c++',
    '.h',
    '.hh',
    '.hpp',
    '.hxx',
    '.h++',
    '.ipp',
    '.inl',
    '.tpp',
];

/**
 * Feeds IntelliSense configurations to the C/C++ extension. For every source
 * file it resolves the owning ROS 2 package and returns a small, concrete
 * `includePath` containing that package, its dependencies and the ROS distro.
 */
export class RosConfigurationProvider implements CustomConfigurationProvider {
    readonly name = PROVIDER_NAME;
    readonly extensionId = EXTENSION_ID;

    constructor(private readonly controller: RosController) {}

    dispose(): void {
        // Nothing to clean up.
    }

    private isSourceFile(uri: vscode.Uri): boolean {
        if (uri.scheme !== 'file') {
            return false;
        }
        const lower = uri.fsPath.toLowerCase();
        return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
    }

    canProvideConfiguration(uri: vscode.Uri): Thenable<boolean> {
        return Promise.resolve(
            this.isSourceFile(uri) && !!this.controller.configurationWorkspaceFor(uri),
        );
    }

    provideConfigurations(uris: vscode.Uri[]): Thenable<SourceFileConfigurationItem[]> {
        const items: SourceFileConfigurationItem[] = [];
        for (const uri of uris) {
            const configuration = this.configurationFor(uri);
            if (configuration) {
                items.push({ uri, configuration });
            }
        }
        return Promise.resolve(items);
    }

    private configurationFor(uri: vscode.Uri): SourceFileConfiguration | undefined {
        const workspace = this.controller.configurationWorkspaceFor(uri);
        if (!workspace) {
            return undefined;
        }
        const pkg = this.controller.packageForFile(uri.fsPath);
        return {
            includePath: this.controller.includePathsFor(workspace, pkg),
            // The real compile command's -D flags (EIGEN_*, BOOST_*, QT_*, …).
            // Without them macro-guarded code is parsed differently from the build.
            defines: this.controller.definesForPath(uri.fsPath),
            compilerPath: workspace.compilerPath,
            // The file's own -std= when the build database has one, otherwise the
            // compiler default for its language (gnu17 for C, gnu++17 for C++).
            standard:
                this.controller.standardForPath(uri.fsPath) ??
                defaultStandardFor(uri.fsPath),
            intelliSenseMode: workspace.intelliSenseMode,
        };
    }

    private workspaceSymbolSearchEnabled(): boolean {
        return vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .get<boolean>('enableWorkspaceSymbolSearch', true);
    }

    canProvideBrowseConfiguration(): Thenable<boolean> {
        return Promise.resolve(this.workspaceSymbolSearchEnabled());
    }

    provideBrowseConfiguration(): Thenable<WorkspaceBrowseConfiguration | null> {
        return Promise.resolve(
            this.browseConfigurationForWorkspaces(this.controller.workspaces),
        );
    }

    canProvideBrowseConfigurationsPerFolder(): Thenable<boolean> {
        return Promise.resolve(this.workspaceSymbolSearchEnabled());
    }

    provideFolderBrowseConfiguration(
        uri: vscode.Uri,
    ): Thenable<WorkspaceBrowseConfiguration | null> {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) {
            return Promise.resolve(null);
        }
        const folderRoot = folder.uri.fsPath;
        // A folder can contain several nested workspaces (e.g. `<repo>/mobile`
        // and `<repo>/user_input`). Include all of them in the symbol index;
        // picking only the first would hide the others from Find All References.
        const workspaces = this.controller.workspaces.filter(
            (candidate) =>
                candidate.root === folderRoot ||
                candidate.root.startsWith(`${folderRoot}${path.sep}`),
        );
        return Promise.resolve(this.browseConfigurationForWorkspaces(workspaces));
    }

    /**
     * Symbol-search index for one or more workspaces. Concrete source roots only
     * (`src/**`, `include/**`, and the same pair for packages kept directly
     * under a repo root), so `build/`, `install/` and `log/` are never indexed.
     * This is what makes "Find All References" see declarations in `include/`
     * too, not just `src/`.
     */
    private browseConfigurationForWorkspaces(
        workspaces: RosWorkspace[],
    ): WorkspaceBrowseConfiguration | null {
        if (workspaces.length === 0) {
            return null;
        }
        const browsePath = [
            ...new Set(workspaces.flatMap((workspace) => workspaceBrowsePaths(workspace.root))),
        ];
        return {
            browsePath,
            compilerPath: workspaces[0].compilerPath,
            // Workspace-wide index: a single standard has to serve every file,
            // so keep the modern compiler default (per-file configs still win).
            standard: 'gnu++17',
        };
    }
}
