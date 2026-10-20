# <img src="media/icon.png" alt="ROS 2 IntelliSense icon" width="32" height="32"> ROS 2 IntelliSense

Per-package C/C++ IntelliSense and `colcon` builds for ROS 2 workspaces in VS Code.

The extension registers a **Custom Configuration Provider** with Microsoft's
C/C++ extension (`ms-vscode.cpptools`). For every C/C++ file it finds the owning
ROS 2 package and supplies that package's include paths, its `package.xml`
dependencies, the detected ROS install, and — for built files — the exact
`-I` / `-D` / `-std` flags from `compile_commands.json`. It can also run
`colcon build` and merge the resulting compile databases.

> **Status:** `0.1.8` (beta). Linux and WSL 2 are supported; macOS is best
> effort; native Windows is not supported. Distributed as a VSIX; it is not
> published on the VS Code Marketplace.

**Jump to:** [Limitations](#limitations) · [Install](#install) · [Usage](#usage) ·
[How it works](#how-it-works) · [Commands](#commands) · [Settings](#settings) ·
[Troubleshooting](#troubleshooting)

## What you get

- **Per file, not per workspace.** The include path follows the file you are
  editing: the owning package, its dependencies, the ROS install, and the exact
  flags from the build.
- **Zero configuration.** When no configuration provider is selected, the
  extension selects itself. If another provider is already configured (for
  example CMake Tools), it asks once and respects the answer.
- **Exact build flags.** It forwards the file's own `-I` / `-isystem`, `-D` and
  `-std` from `compile_commands.json`, including databases produced by a normal
  terminal build.
- **ROS install discovery.** apt (`/opt/ros`), RoboStack/conda, Docker, custom
  prefixes and source builds are detected from the sourced environment.
- **Build integration.** Run `colcon build` from VS Code and merge every
  `build/*/compile_commands.json` into one file.
- **References across the workspace.** The symbol index covers `src/**` and
  `include/**` (and packages kept directly under a repo root), so Find All
  References sees declarations in headers too.
- **Lightweight.** No polling and no full workspace scan. Include paths are
  concrete and non-recursive by default.

## Requirements

- VS Code 1.85+.
- The [C/C++ extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)
  (`ms-vscode.cpptools`) — declared as a hard dependency.
- A ROS 2 installation (apt under `/opt/ros`, a RoboStack/conda environment, or
  any custom prefix). The extension discovers it from the sourced environment;
  `ros2IntelliSense.rosPrefix` pins it when auto-detection is not possible.
- `colcon` on `PATH` (only needed for the build commands).
- Linux and WSL 2, on **x86_64 and arm64** (Jetson, Raspberry Pi). macOS is best
  effort; native Windows is not supported — use WSL 2.

## Limitations

- **Platform:** Linux and WSL 2 are the supported targets. Native Windows is not
  supported; macOS is best effort and not validated.
- **Validated environment:** Ubuntu 24.04, GCC 13, ROS 2 Jazzy, VS Code 1.142 and
  cpptools 1.34.4. arm64, clang, conda/RoboStack and C++14/20 workspaces are
  handled in the code but have not been validated on real hardware.
- **Workspace layouts:** sibling source includes cover `<ws>/src/<dep>` and
  `<repo>/<dep>`, not grouped layouts such as `src/<group>/<dep>`. Grouped colcon
  layouts are discovered up to two levels under `src/`.
- **Multi-root windows:** provider-conflict detection and the
  `c_cpp_properties.json` check focus on the first workspace folder.
- **`Build My Packages` fallback:** if `src/<user>` does not exist, it falls back
  to `src`, then to the workspace root, so it may build more than “your”
  packages. Set `ros2IntelliSense.mineBasePath` to be strict.
- **Provider ownership:** only one configuration provider can be active. The
  extension never silently overrides CMake Tools; it asks once. The two cannot
  feed the C/C++ extension at the same time.
- **First activation writes a setting:** when no provider is configured, the
  extension writes `C_Cpp.default.configurationProvider` into workspace settings
  so a fresh clone works without a setup command.
- **No Marketplace or auto-update:** install and upgrade from the VSIX manually.
- **No telemetry or network access.** Builds run only when you invoke a build
  command.

## Install

### From the VSIX (recommended)

1. Get `ros2-intellisense-0.1.8.vsix`.
2. Install it from a terminal:

   ```bash
   code --install-extension ros2-intellisense-0.1.8.vsix --force
   ```

   Or use VS Code: **Extensions** → `...` → **Install from VSIX…**.
3. Reload VS Code: `Ctrl+Shift+P` → **Developer: Reload Window**.
4. Open a ROS 2 workspace folder. After opening a C/C++ file, the status bar
   should show the owning package, for example `ROS: my_robot`.

Check that the extension is installed:

```bash
code --list-extensions | grep ros2-intellisense
```

When upgrading, reload first and then remove the stale
`~/.vscode/extensions/macianz.ros2-intellisense-<old-version>` directory if it is
still present.

### From source

```bash
npm install
npm run compile
# then press F5 in VS Code, or: npm run package
```

`npm run package` produces `ros2-intellisense-<version>.vsix` in the repository
root.

### First run

1. Open your ROS 2 workspace folder.
2. Open a package source file and check the status bar.
3. If the C/C++ extension was already using another provider, accept the
   one-time prompt to switch.
4. Run **ROS 2: Build Workspace** if you want exact flags and defines (optional
   for IntelliSense; the package and ROS includes work before a build).

## Usage

### 1. Open the workspace

Open the folder that contains your colcon workspace. Nested workspaces are
supported: if the folder you open is not itself a colcon root, the extension
looks for roots below it (for example `<repo>/mobile/` with its own
`build/ install/ log/`) and uses the nearest one for each file.

These layouts also work without any configuration:

- the repository **is** the package (`package.xml` at the root);
- the repository keeps packages directly under the root, with no `src/`;
- a nested workspace has only `src/` and has not been built yet.

### 2. Pick the ROS 2 distribution

The install prefix and distro are auto-detected from `ROS_DISTRO`,
`.ros-intellisense.env`, `AMENT_PREFIX_PATH` / `COLCON_PREFIX_PATH` /
`CONDA_PREFIX`, and finally `/opt/ros`. This covers apt, RoboStack/conda,
Docker/Dev Containers and source builds. If several are installed, pin one with
**ROS 2: Select ROS 2 Distribution** (written to workspace settings as
`ros2IntelliSense.rosDistro`); use `ros2IntelliSense.rosPrefix` when the
environment is not visible to VS Code.

### 3. IntelliSense is enabled automatically

Nothing to configure: when a ROS 2 workspace is detected and no provider is
selected, the extension writes
`"C_Cpp.default.configurationProvider": "macianz.ros2-intellisense"` to
`.vscode/settings.json`. If the C/C++ extension already uses another provider,
accept the one-time prompt to switch.

**ROS 2: Set Up Workspace for IntelliSense** is still available as an explicit
fallback. It also writes a baseline `c_cpp_properties.json` (useful when the
provider is disabled) and never overwrites an existing `compileCommands` entry.

### 4. Edit C/C++ files

Open any `.c`, `.cpp`, `.h` or `.hpp` file inside a ROS 2 package. The status bar
shows the owning package, e.g. `ROS: my_robot`, and IntelliSense resolves:

- the package's own `include/`,
- every dependency listed in its `package.xml`,
- the ROS 2 installation (one non-recursive root per ROS-layout package),
- the exact `-I` / `-isystem` flags, `-D` defines and `-std` from
  `compile_commands.json`, when a build exists.

The active package follows the file you are editing, so switching packages needs
no command. The symbol index covers `src/**` and `include/**` (plus the same pair
for packages kept directly under a repo root), so "Find All References" sees
declarations in headers too. A ROS header opened with go-to-definition gets the
same full configuration instead of the fallback one.

### 5. Build and refresh

Run **ROS 2: Build Workspace**, or **Build Package…** / **Build My Packages** for
a subset. The extension sources the distro and the workspace
`install/setup.bash`, runs `colcon build`, merges every
`build/*/compile_commands.json` into `build/compile_commands.json`, and
re-queries the provider.

If you build with `colcon` in a terminal instead, the per-package
`build/<pkg>/compile_commands.json` files are detected and watched automatically;
the merge command is optional. After adding or removing a `package.xml`
dependency, run **ROS 2: Refresh Active Package / IntelliSense** (or reload the
window) to recompute the include paths.

## How it works

`compile_commands.json` is great, but it only describes files that were actually
compiled, and it does not change when you switch packages. This extension
registers a **Custom Configuration Provider** with the C/C++ extension, so
IntelliSense is computed live for every file:

1. Find the `package.xml` that owns the file (walking up from the file).
2. Add that package's `include/` directory.
3. Add the include directories of every dependency in its `package.xml`.
4. Add this workspace's `install/**`.
5. If the file has a compile entry, put its exact `-I` flags first and use them
   as the primary include set, adding only the roots of declared direct
   dependencies; otherwise add one non-recursive root per ROS-layout package
   (`<ros-prefix>/include/<pkg>`) as a fallback. Headers and unbuilt files
   therefore keep working without a build database.
6. Forward the exact `-D` defines and `-std` of that file's compile command (if it
   has an entry), so macro-guarded code and the language standard match the build.

All include paths are concrete and **non-recursive**, so the C/C++ engine never
walks your whole workspace. Completion and go-to-definition therefore resolve
your package and its dependencies even before a full build, and even when you
have not merged anything.

### Provider details

- Only **one** configuration provider can be active per workspace. If you also
  use CMake Tools (`ms-vscode.cmake-tools`) as a provider, pick one — they cannot
  both feed the C/C++ extension.
- A provider is **not** mutually exclusive with a native `c_cpp_properties.json`:
  the extension only claims C/C++ files inside a detected ROS workspace (and
  headers under the ROS installation's `include/`) and leaves everything else to
  your existing configuration.
- Per file it supplies `includePath`, the `-D` defines from the real compile
  command, `compilerPath`, the file's own `-std=` (falling back to `gnu17` for C
  and `gnu++17` for C++) and `intelliSenseMode`.
- `compilerPath` resolves as
  `ros2IntelliSense.compilerPath` → `C_Cpp.default.compilerPath` → `$CXX` → the
  platform default (the **C++** driver where available), so it does not override
  a compiler you picked for the C/C++ extension.

## Commands

| Command | What it does |
|---------|--------------|
| `ROS 2: Build Workspace` | `colcon build` + merge `compile_commands.json` |
| `ROS 2: Build Package…` | Build one or more selected packages |
| `ROS 2: Build My Packages` | Build `src/<user>`, falling back to `src` or the workspace root |
| `ROS 2: Merge compile_commands.json` | Merge `build/*/compile_commands.json` only |
| `ROS 2: Refresh Active Package / IntelliSense` | Re-scan packages and re-detect the active package |
| `ROS 2: Show Active Package` | Show name, path, build type and dependencies |
| `ROS 2: Set Up Workspace for IntelliSense` | Write `.vscode` configs (non-destructive) |
| `ROS 2: Select ROS 2 Distribution` | Pin the distro in workspace settings |

A status-bar item on the left shows the active package, e.g. `ROS: my_robot`.
Click it to inspect the package.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `ros2IntelliSense.rosDistro` | `""` (auto) | ROS distro; empty auto-detects `ROS_DISTRO`, `.ros-intellisense.env`, the sourced environment, `/opt/ros`. |
| `ros2IntelliSense.rosPrefix` | `""` (auto) | Absolute ROS 2 install prefix (the directory with `setup.bash`), e.g. a conda env. Empty auto-detects. |
| `ros2IntelliSense.compilerPath` | `""` (→ `C_Cpp.default.compilerPath`, `$CXX`, then the platform default) | Compiler used for IntelliSense. |
| `ros2IntelliSense.parallelWorkers` | `4` | `--parallel-workers` for colcon. |
| `ros2IntelliSense.mineBasePath` | `""` (`src/<user>`, then `src`, then the root) | Base path for "Build My Packages". |
| `ros2IntelliSense.extraIncludePaths` | `[]` | Extra include dirs; `${workspaceFolder}` is expanded. |
| `ros2IntelliSense.includeMode` | `package` | `package` = lightest (active package + deps + distro + exact compile flags). `workspace` = also add `${workspaceFolder}/**`. |
| `ros2IntelliSense.enableWorkspaceSymbolSearch` | `true` | Feed a `browse` index covering `src/**` and `include/**` (including packages directly under the root). Set `false` for the lightest setup. |
| `ros2IntelliSense.enableConfigurationProvider` | `true` | Register the C/C++ Custom Configuration Provider and select it automatically when no other provider is configured. |
| `ros2IntelliSense.sourceSetupScripts` | `[]` | Extra setup scripts sourced before `colcon build`. |

## How the build works

`ROS 2: Build Workspace` runs, in the workspace root:

```bash
source <ros-prefix>/setup.bash
[ -f install/setup.bash ] && source install/setup.bash
colcon build --symlink-install --parallel-workers 4 \
  --cmake-args -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

Afterwards every `build/*/compile_commands.json` is merged (de-duplicated) into
`build/compile_commands.json`, and the provider is notified to refresh.

## Troubleshooting

- **IntelliSense not updating**: run **ROS 2: Refresh Active Package / IntelliSense**, or `Ctrl+Shift+P` → *C/C++: Reset IntelliSense Database*.
- **Suggestions feel slow**: the extension already uses a built file's exact
  compile includes instead of every ROS root. For extra responsiveness, lower
  `C_Cpp.intelliSenseUpdateDelay` to `300`–`500` ms; set
  `ros2IntelliSense.enableWorkspaceSymbolSearch` to `false` if you do not need
  Find All References across the workspace.
- **Provider not used**: the extension selects itself when no provider is
  configured. If you previously chose another provider, run **ROS 2: Set Up
  Workspace for IntelliSense** (or set
  `"C_Cpp.default.configurationProvider": "macianz.ros2-intellisense"` in
  `.vscode/settings.json`) and accept the C/C++ prompt.
- **`cannot open source file "rclcpp/rclcpp.hpp"`**: no usable ROS distro was
  detected (or the C/C++ engine has not reloaded). Check the status bar, run
  **ROS 2: Select ROS 2 Distribution**, then reload the window. For a ROS install
  outside `/opt/ros` (conda, custom prefix), set
  `ros2IntelliSense.rosPrefix`.
- **Every C++11+ construct is flagged** (`namespace "std" has no member
  "make_shared"` / `"chrono_literals"`, `using X = Y;` reported as a syntax
  error, then a cascade of `expected a declaration`): on **0.1.2–0.1.3** this was
  caused by the provider's include path shadowing a system header. Some ROS
  packages drop loose headers into `include/<pkg>/`, so `lely/features.h` won
  over glibc's `<features.h>` and broke all of libstdc++. Fixed in 0.1.4, which
  only exposes packages that follow the ROS layout (`include/<pkg>/<pkg>/…`).
  Your code was never the problem (`gcc` defaults to `gnu++17`).
- **My chosen compiler is ignored**: leave `ros2IntelliSense.compilerPath` empty
  to inherit `C_Cpp.default.compilerPath`, or set it to your compiler.
- **Wrong distro**: **ROS 2: Select ROS 2 Distribution**.
- **Build fails**: ensure ROS is sourced; the extension sources the detected
  ROS prefix and the workspace `install/setup.bash` for you. For a conda
  environment, activate it before starting VS Code (or set `rosPrefix`).
- **Windows**: open the folder in WSL.

## Development

```bash
npm install
npm run watch      # or `npm run compile`
npm test           # unit tests for the pure helpers (parsing, ROS discovery, include planning, toolchain)
npm run smoke      # headless activation test against a temp workspace
npm run check      # type-check only (no emit)
npm run package    # produces a .vsix
```

See the log in the **Output → ROS 2 IntelliSense** channel.

For architecture, invariants, the build/install workflow and the current open
threads, see [`AGENTS.md`](./AGENTS.md) — it is written to be the first thing a
contributor (or a coding agent) reads.

Version history lives in [`CHANGELOG.md`](./CHANGELOG.md).

## License

MIT. See [LICENSE](https://github.com/MaCianz21/ROS-intellisense-setup/blob/master/LICENSE)
for the full text.
