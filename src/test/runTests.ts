/**
 * Plain-Node unit tests for the pure/vscode-free helpers: parsing, colcon
 * discovery, ROS install discovery, include planning and toolchain selection.
 * Run with `npm test` (compiles first, then executes this file).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    discoverNestedWorkspaces,
    isColconRoot,
    looksLikeRosWorkspace,
    workspaceBrowsePaths,
} from '../colcon';
import {
    compileCommandFlags,
    compileEntryForFile,
    defaultStandardFor,
    definesForFile,
    includeDirectoriesFromCompileCommands,
    normalizeStandard,
    parsePackageManifest,
    shellQuote,
    standardForFile,
    tokenizeCommand,
} from '../parse';
import { packageIncludeRootsIn, planIncludePaths, rosPackageIncludeRoots } from '../includeResolver';
import {
    discoverRosInstalls,
    isRosHeaderPath,
    resolveRosInstall,
    rosDistroInPrefix,
} from '../rosEnvironment';
import { intelliSenseModeFor } from '../toolchain';

let failures = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (error) {
        failures++;
        console.error(`FAIL  ${name}`);
        console.error(`      ${(error as Error).message}`);
    }
}

const manifest = `<?xml version="1.0"?>
<package format="3">
  <name>my_robot</name>
  <version>0.1.0</version>
  <!-- a comment that must be ignored -->
  <buildtool_depend>ament_cmake</buildtool_depend>
  <depend>rclcpp</depend>
  <depend>std_msgs</depend>
  <build_depend>builtin_interfaces</build_depend>
  <exec_depend>ros2launch</exec_depend>
  <test_depend>ament_cmake_gtest</test_depend>
  <export>
    <build_type>ament_cmake</build_type>
  </export>
</package>`;

check('parses the package name', () => {
    assert.strictEqual(parsePackageManifest(manifest)?.name, 'my_robot');
});

check('collects and de-duplicates dependencies across tags', () => {
    const parsed = parsePackageManifest(manifest);
    assert.deepStrictEqual(parsed?.dependencies, [
        'ament_cmake',
        'rclcpp',
        'std_msgs',
        'builtin_interfaces',
        'ros2launch',
    ]);
});

check('ignores test_depend (never contributes headers)', () => {
    assert.ok(!parsePackageManifest(manifest)?.dependencies.includes('ament_cmake_gtest'));
});

check('detects the build type', () => {
    assert.strictEqual(parsePackageManifest(manifest)?.buildType, 'ament_cmake');
});

check('falls back to a build-tool dependency for the build type', () => {
    const xml = '<package><name>p</name><buildtool_depend>ament_python</buildtool_depend></package>';
    assert.strictEqual(parsePackageManifest(xml)?.buildType, 'ament_python');
});

check('returns undefined without a name', () => {
    assert.strictEqual(parsePackageManifest('<package></package>'), undefined);
});

check('extracts -I, -isystem and -I<dir> flags (command form)', () => {
    const json = JSON.stringify([
        {
            directory: '/ws/build/pkg',
            command: "/usr/bin/c++ -I/opt/ros/jazzy/include -isystem /usr/include/x -Irel/include -c a.cpp",
        },
    ]);
    const includes = includeDirectoriesFromCompileCommands(json);
    assert.ok(includes.includes('/opt/ros/jazzy/include'), 'absolute -I');
    assert.ok(includes.includes('/usr/include/x'), 'space-separated -isystem');
    assert.ok(includes.includes('/ws/build/pkg/rel/include'), 'relative resolved against directory');
});

check('extracts includes from the arguments form', () => {
    const json = JSON.stringify([
        { directory: '/ws', arguments: ['c++', '-I', '/a/b', '-isystem/opt/c', '-c', 'x.cpp'] },
    ]);
    const includes = includeDirectoriesFromCompileCommands(json);
    assert.deepStrictEqual([...includes].sort(), ['/a/b', '/opt/c']);
});

check('tolerates invalid JSON', () => {
    assert.deepStrictEqual(includeDirectoriesFromCompileCommands('not json'), []);
});

check('tokenises quoted arguments', () => {
    assert.deepStrictEqual(tokenizeCommand(`cc -DVALUE="a b" -I'/opt/ros/x' file.cpp`), [
        'cc',
        '-DVALUE=a b',
        '-I/opt/ros/x',
        'file.cpp',
    ]);
});

check('keeps flags that follow an escaped-quote define', () => {
    assert.deepStrictEqual(
        tokenizeCommand('/usr/bin/c++ -DROS_PACKAGE_NAME=\\"pkg\\" -I/a -c /x.cpp'),
        ['/usr/bin/c++', '-DROS_PACKAGE_NAME="pkg"', '-I/a', '-c', '/x.cpp'],
    );
});

check('collects compile flags and defines per file', () => {
    const json = JSON.stringify([
        {
            directory: '/ws',
            file: '/ws/src/a.cpp',
            command:
                '/usr/bin/c++ -DFOO=1 -DBAR -std=gnu++20 -I/opt/ros/jazzy/include/rclcpp -c a.cpp',
        },
        {
            directory: '/ws',
            file: '/ws/src/b.cpp',
            arguments: ['c++', '-D', 'BAZ', '-std', 'c++14', '-I', '/ws/include', '-c', 'b.cpp'],
        },
    ]);
    const flags = compileCommandFlags(json);
    assert.strictEqual(compileEntryForFile(flags, '/ws/src/a.cpp')?.file, '/ws/src/a.cpp');
    assert.strictEqual(compileEntryForFile(flags, '/ws/src/missing.cpp'), undefined);
    assert.deepStrictEqual(definesForFile(flags, '/ws/src/a.cpp'), ['FOO=1', 'BAR']);
    assert.deepStrictEqual(definesForFile(flags, '/ws/src/b.cpp'), ['BAZ']);
    assert.deepStrictEqual(definesForFile(flags, '/ws/src/missing.cpp'), []);
    assert.strictEqual(standardForFile(flags, '/ws/src/a.cpp'), 'gnu++20');
    assert.strictEqual(standardForFile(flags, '/ws/src/b.cpp'), 'c++14');
    assert.strictEqual(standardForFile(flags, '/ws/src/missing.cpp'), undefined);
    assert.deepStrictEqual([...includeDirectoriesFromCompileCommands(json)].sort(), [
        '/opt/ros/jazzy/include/rclcpp',
        '/ws/include',
    ]);
});

check('normalises -std aliases to values cpptools accepts', () => {
    assert.strictEqual(normalizeStandard('gnu++2b'), 'gnu++23');
    assert.strictEqual(normalizeStandard('c++2a'), 'c++20');
    assert.strictEqual(normalizeStandard('c++1z'), 'c++17');
    assert.strictEqual(normalizeStandard('c++latest'), 'c++23');
    assert.strictEqual(normalizeStandard('gnu17'), 'gnu17');
    assert.strictEqual(normalizeStandard('bogus'), undefined);
    assert.strictEqual(normalizeStandard(undefined), undefined);
});

check('reads the MSVC /std: spelling', () => {
    const flags = compileCommandFlags(
        JSON.stringify([
            { file: '/ws/x.cpp', arguments: ['cl.exe', '/std:c++20', '/c', 'x.cpp'] },
        ]),
    );
    assert.strictEqual(standardForFile(flags, '/ws/x.cpp'), 'c++20');
});

check('falls back to the compiler default standard per language', () => {
    assert.strictEqual(defaultStandardFor('/ws/src/a.c'), 'gnu17');
    assert.strictEqual(defaultStandardFor('/ws/src/a.cpp'), 'gnu++17');
    assert.strictEqual(defaultStandardFor('/ws/include/a.h'), 'gnu++17');
});

check('single-quotes values for the shell', () => {
    assert.strictEqual(shellQuote('plain'), "'plain'");
    assert.strictEqual(shellQuote("it's"), "'it'\\''s'");
});

const workspace = {
    root: '/ws',
    srcDir: '/ws/src',
    installDir: '/ws/install',
    distro: 'jazzy',
    rosPrefix: '/opt/ros/jazzy',
    // Cast: the planner only reads the fields above.
} as unknown as Parameters<typeof planIncludePaths>[0];
const robotPackage = {
    name: 'my_robot',
    dir: '/ws/src/my_robot',
    manifest: '/ws/src/my_robot/package.xml',
    dependencies: ['rclcpp', 'my_msgs'],
} as unknown as Parameters<typeof planIncludePaths>[1];

check('package mode uses concrete, non-recursive include roots', () => {
    const paths = planIncludePaths(workspace, robotPackage, {
        mode: 'package',
        compileIncludes: [],
        extraIncludePaths: [],
    });
    assert.ok(paths.includes('/ws/src/my_robot/include'), 'active package include');
    assert.ok(paths.includes('/ws/install/my_msgs/include'), 'dependency install include');
    assert.ok(paths.includes('/opt/ros/jazzy/include'), 'non-recursive ROS root');
    assert.ok(!paths.some((p) => p.endsWith('/**')), 'no recursive globs in package mode');
    assert.ok(!paths.includes('/ws'), 'does not include the whole workspace');
});

check('finds nested workspaces, including unbuilt ones', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'colcon-'));
    try {
        const ws = path.join(base, 'mobile');
        fs.mkdirSync(path.join(ws, 'build'), { recursive: true });
        fs.mkdirSync(path.join(ws, 'install'), { recursive: true });
        fs.mkdirSync(path.join(ws, 'log'), { recursive: true });

        // A workspace that has only `src/` (never built).
        const unbuilt = path.join(base, 'unbuilt');
        fs.mkdirSync(path.join(unbuilt, 'src', 'pkg'), { recursive: true });
        fs.writeFileSync(
            path.join(unbuilt, 'src', 'pkg', 'package.xml'),
            '<package><name>pkg</name></package>',
        );

        const plainBuild = path.join(base, 'plain');
        fs.mkdirSync(path.join(plainBuild, 'build'), { recursive: true });

        // A generic project with `src/` but no ROS packages: not a workspace.
        const generic = path.join(base, 'generic');
        fs.mkdirSync(path.join(generic, 'src'), { recursive: true });

        // A package that happens to contain stray colcon folders.
        const pkg = path.join(base, 'my_pkg');
        fs.mkdirSync(path.join(pkg, 'build'), { recursive: true });
        fs.mkdirSync(path.join(pkg, 'install'), { recursive: true });
        fs.mkdirSync(path.join(pkg, 'log'), { recursive: true });
        fs.writeFileSync(path.join(pkg, 'package.xml'), '<package><name>my_pkg</name></package>');

        // An executable named `install` (as shipped by some packages).
        const scripts = path.join(base, 'scripts');
        fs.mkdirSync(scripts, { recursive: true });
        fs.writeFileSync(path.join(scripts, 'install'), '#!/bin/sh\n');

        assert.strictEqual(isColconRoot(ws), true, 'build+install+log is a colcon root');
        assert.strictEqual(isColconRoot(plainBuild), false, 'build/ alone is not a colcon root');
        assert.strictEqual(isColconRoot(pkg), false, 'a package with package.xml is not a workspace');
        assert.strictEqual(isColconRoot(scripts), false, 'a file named install is not a workspace');
        assert.deepStrictEqual(
            discoverNestedWorkspaces(base).sort(),
            [ws, unbuilt].sort(),
            'finds built and unbuilt roots, but not packages or bare build dirs',
        );
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

check('does not mistake <ws>/src for a nested workspace', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'colcon-src-'));
    try {
        const pkg = path.join(base, 'src', 'demo_pkg');
        fs.mkdirSync(pkg, { recursive: true });
        fs.writeFileSync(path.join(pkg, 'package.xml'), '<package><name>demo_pkg</name></package>');
        assert.deepStrictEqual(discoverNestedWorkspaces(base), []);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

check('recognises package-at-root and multi-package repos', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ros-layout-'));
    try {
        const packageRoot = path.join(base, 'single');
        fs.mkdirSync(packageRoot, { recursive: true });
        fs.writeFileSync(
            path.join(packageRoot, 'package.xml'),
            '<package><name>single</name></package>',
        );
        assert.strictEqual(looksLikeRosWorkspace(packageRoot), true);

        const multi = path.join(base, 'multi');
        fs.mkdirSync(path.join(multi, 'pkg_a'), { recursive: true });
        fs.writeFileSync(
            path.join(multi, 'pkg_a', 'package.xml'),
            '<package><name>pkg_a</name></package>',
        );
        assert.strictEqual(looksLikeRosWorkspace(multi), true);

        const ignored = path.join(base, 'ignored');
        fs.mkdirSync(path.join(ignored, 'pkg_b'), { recursive: true });
        fs.writeFileSync(
            path.join(ignored, 'pkg_b', 'package.xml'),
            '<package><name>pkg_b</name></package>',
        );
        fs.writeFileSync(path.join(ignored, 'pkg_b', 'COLCON_IGNORE'), '');
        assert.strictEqual(looksLikeRosWorkspace(ignored), false);

        const empty = path.join(base, 'empty');
        fs.mkdirSync(empty);
        assert.strictEqual(looksLikeRosWorkspace(empty), false);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

check('browse paths cover src, include and direct packages', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-'));
    try {
        const ws = path.join(base, 'ws');
        fs.mkdirSync(path.join(ws, 'src', 'pkg'), { recursive: true });
        fs.mkdirSync(path.join(ws, 'include'), { recursive: true });
        assert.deepStrictEqual(workspaceBrowsePaths(ws), [`${ws}/src/**`, `${ws}/include/**`]);

        const repo = path.join(base, 'repo');
        fs.mkdirSync(path.join(repo, 'pkg_a', 'src'), { recursive: true });
        fs.mkdirSync(path.join(repo, 'pkg_a', 'include'), { recursive: true });
        fs.writeFileSync(
            path.join(repo, 'pkg_a', 'package.xml'),
            '<package><name>pkg_a</name></package>',
        );
        assert.deepStrictEqual(workspaceBrowsePaths(repo), [
            `${repo}/pkg_a/src/**`,
            `${repo}/pkg_a/include/**`,
        ]);

        const packageRoot = path.join(base, 'package');
        fs.mkdirSync(path.join(packageRoot, 'src'), { recursive: true });
        fs.mkdirSync(path.join(packageRoot, 'include'), { recursive: true });
        fs.writeFileSync(
            path.join(packageRoot, 'package.xml'),
            '<package><name>package</name></package>',
        );
        assert.deepStrictEqual(workspaceBrowsePaths(packageRoot), [
            `${packageRoot}/src/**`,
            `${packageRoot}/include/**`,
        ]);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

check('adds per-package ROS include roots (non-recursive)', () => {
    const paths = planIncludePaths(workspace, robotPackage, {
        mode: 'package',
        compileIncludes: [],
        extraIncludePaths: [],
        rosIncludeRoots: ['/opt/ros/jazzy/include', '/opt/ros/jazzy/include/rclcpp'],
    });
    assert.ok(paths.includes('/opt/ros/jazzy/include/rclcpp'), 'per-package ROS root');
    assert.ok(!paths.some((p) => p.endsWith('/**')), 'still no recursive globs');
});

check('puts compile includes before the ROS package roots', () => {
    const paths = planIncludePaths(workspace, robotPackage, {
        mode: 'package',
        compileIncludes: ['/ws/generated/include'],
        extraIncludePaths: [],
        rosIncludeRoots: ['/opt/ros/jazzy/include/rclcpp'],
    });
    assert.ok(
        paths.indexOf('/ws/generated/include') <
            paths.indexOf('/opt/ros/jazzy/include/rclcpp'),
        'exact build include wins over the broad ROS roots',
    );
});

check('exact compile mode can omit ROS package roots', () => {
    const paths = planIncludePaths(workspace, robotPackage, {
        mode: 'package',
        compileIncludes: ['/ws/generated/include'],
        extraIncludePaths: [],
        rosIncludeRoots: [],
    });
    assert.ok(paths.includes('/ws/generated/include'));
    assert.ok(paths.includes('/opt/ros/jazzy/include'), 'base ROS include stays');
    assert.ok(!paths.includes('/opt/ros/jazzy/include/rclcpp'), 'roots are omitted');
});

check('ROS package roots expose only packages with the ROS layout', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ros-roots-'));
    try {
        // A well-behaved ROS package: include/rclcpp/rclcpp/...
        fs.mkdirSync(path.join(base, 'rclcpp', 'rclcpp'), { recursive: true });
        // A flat bundle whose loose `features.h` would shadow glibc's.
        fs.mkdirSync(path.join(base, 'lely'), { recursive: true });
        fs.writeFileSync(path.join(base, 'lely', 'features.h'), '');
        // A flat bundle exposing a directory named like a std header (`utility`).
        fs.mkdirSync(path.join(base, 'depthai', 'utility'), { recursive: true });
        // A loose file in the include directory itself must never become a root.
        fs.writeFileSync(path.join(base, 'stray.h'), '');

        const roots = packageIncludeRootsIn(base);
        assert.deepStrictEqual(roots, [base, path.join(base, 'rclcpp')]);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

check('reads the distro from a non-/opt/ros install prefix', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ros-prefix-'));
    try {
        const prefix = path.join(base, 'conda-env');
        const envDir = path.join(prefix, 'share', 'ros_environment', 'environment');
        fs.mkdirSync(envDir, { recursive: true });
        fs.writeFileSync(path.join(envDir, '1.ros_distro.dsv'), 'set;ROS_DISTRO;humble\n');

        assert.strictEqual(rosDistroInPrefix(prefix), 'humble');

        // `.sh` representation, used by some installs instead of `.dsv`.
        const shPrefix = path.join(base, 'source-build');
        const shEnv = path.join(shPrefix, 'share', 'ros_environment', 'environment');
        fs.mkdirSync(shEnv, { recursive: true });
        fs.writeFileSync(path.join(shEnv, '1.ros_distro.sh'), 'export ROS_DISTRO=iron\n');
        assert.strictEqual(rosDistroInPrefix(shPrefix), 'iron');

        // Explicit prefix wins, even though /opt/ros may exist on this machine.
        assert.deepStrictEqual(resolveRosInstall({ configuredPrefix: prefix, env: {} }), {
            prefix,
            distro: 'humble',
        });

        // ROS_DISTRO from the environment selects the matching install.
        assert.deepStrictEqual(
            resolveRosInstall({ env: { ROS_DISTRO: 'humble' }, extraPrefixes: [prefix] }),
            { prefix, distro: 'humble' },
        );

        assert.ok(
            discoverRosInstalls({ env: {}, extraPrefixes: [prefix] }).some(
                (install) => install.prefix === prefix && install.distro === 'humble',
            ),
        );

        // An explicitly configured distro is honoured even when it is not installed.
        assert.strictEqual(
            resolveRosInstall({ configuredDistro: 'humble', env: {} })?.distro,
            'humble',
        );
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

check('ROS include roots follow the installation prefix', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ros-roots-prefix-'));
    try {
        const prefix = path.join(base, 'env');
        fs.mkdirSync(path.join(prefix, 'include', 'rclcpp', 'rclcpp'), { recursive: true });
        assert.deepStrictEqual(rosPackageIncludeRoots(prefix), [
            path.join(prefix, 'include'),
            path.join(prefix, 'include', 'rclcpp'),
        ]);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

check('recognises headers inside a ROS install prefix', () => {
    assert.strictEqual(
        isRosHeaderPath(
            '/opt/ros/jazzy/include/geometry_msgs/geometry_msgs/msg/twist.hpp',
            '/opt/ros/jazzy',
        ),
        true,
    );
    assert.strictEqual(
        isRosHeaderPath('/opt/ros/jazzy/share/geometry_msgs/package.xml', '/opt/ros/jazzy'),
        false,
    );
    assert.strictEqual(
        isRosHeaderPath('/opt/ros/humble/include/rclcpp/rclcpp.hpp', '/opt/ros/jazzy'),
        false,
    );
    assert.strictEqual(isRosHeaderPath('/opt/ros/jazzy/include/rclcpp/rclcpp.hpp', ''), false);
});

check('adds source sibling includes before a build', () => {
    const paths = planIncludePaths(workspace, robotPackage, {
        mode: 'package',
        compileIncludes: [],
        extraIncludePaths: [],
        siblingIncludes: ['/ws/src/my_msgs/include'],
    });
    assert.ok(paths.includes('/ws/src/my_msgs/include'));
});

check('plans include paths in the detected prefix, not /opt/ros', () => {
    const condaWorkspace = {
        ...workspace,
        rosPrefix: '/home/u/conda/envs/ros',
    } as unknown as Parameters<typeof planIncludePaths>[0];
    const paths = planIncludePaths(condaWorkspace, undefined, {
        mode: 'package',
        compileIncludes: [],
        extraIncludePaths: [],
    });
    assert.ok(paths.includes('/home/u/conda/envs/ros/include'));
    assert.ok(!paths.includes('/opt/ros/jazzy/include'));
});

check('picks the intelliSense mode from compiler and architecture', () => {
    assert.strictEqual(intelliSenseModeFor('linux', '/usr/bin/g++', 'x64'), 'linux-gcc-x64');
    assert.strictEqual(
        intelliSenseModeFor('linux', '/usr/bin/clang++', 'arm64'),
        'linux-clang-arm64',
    );
    assert.strictEqual(intelliSenseModeFor('wsl', '/usr/bin/g++', 'arm64'), 'linux-gcc-arm64');
    assert.strictEqual(
        intelliSenseModeFor('macos', '/usr/bin/clang++', 'arm64'),
        'macos-clang-arm64',
    );
    assert.strictEqual(
        intelliSenseModeFor('macos', '/opt/homebrew/bin/gcc-14', 'x64'),
        'macos-gcc-x64',
    );
    assert.strictEqual(
        intelliSenseModeFor('windows', 'C:\\LLVM\\bin\\clang++.exe', 'x64'),
        'windows-clang-x64',
    );
    assert.strictEqual(
        intelliSenseModeFor('windows', 'C:\\VC\\bin\\cl.exe', 'x64'),
        'windows-msvc-x64',
    );
});

check('workspace mode adds the broad recursive scan', () => {
    const paths = planIncludePaths(workspace, robotPackage, {
        mode: 'workspace',
        compileIncludes: [],
        extraIncludePaths: [],
    });
    assert.ok(paths.includes('/ws/**'));
});

check('folds in compile flags and expands ${workspaceFolder}', () => {
    const paths = planIncludePaths(workspace, undefined, {
        mode: 'package',
        compileIncludes: ['/ws/install/rclcpp/include'],
        extraIncludePaths: ['${workspaceFolder}/third_party/include'],
    });
    assert.ok(paths.includes('/ws/install/rclcpp/include'));
    assert.ok(paths.includes('/ws/third_party/include'));
});

check('does not duplicate include paths', () => {
    const paths = planIncludePaths(workspace, robotPackage, {
        mode: 'package',
        compileIncludes: ['/opt/ros/jazzy/include', '/ws/src/my_robot/include'],
        extraIncludePaths: [],
    });
    assert.strictEqual(new Set(paths).size, paths.length);
});

if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
}
console.log('\nAll tests passed.');
