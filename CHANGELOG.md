# Changelog

## 0.1.7

- **Zero-config onboarding.** When a ROS 2 workspace is detected and the C/C++
  extension has no configuration provider selected, the extension now selects
  itself in `.vscode/settings.json`. If another provider (for example CMake
  Tools) is already configured, it offers the switch once and respects the
  answer. A fresh clone no longer needs the setup command before IntelliSense
  works.
- **More repository layouts are recognised.** A repo that is the package itself
  (`package.xml` at the root), a repo that keeps packages directly under the root
  (no `src/`), and a nested workspace that only has `src/` are now detected.
  `COLCON_IGNORE` is honoured, and a generic `src/` without ROS packages is not
  mistaken for a workspace.
- **Symbol search covers headers and direct packages.** The browse index now
  includes `src/**` *and* `include/**`, plus the same pair for packages kept
  directly under a repo root. Folders with several nested workspaces (for
  example `<repo>/mobile` and `<repo>/user_input`) index all of them, so
  "Find All References" no longer stops at the first workspace.
- **ROS headers opened by go-to-definition get a full configuration.** Headers
  under `<ros-prefix>/include` are now served by the provider, so cpptools no
  longer falls back to a minimal `c_cpp_properties.json` and shows missing
  includes inside `rclcpp`, `geometry_msgs`, … The status bar also keeps the
  last active package when a ROS header is opened.
- **Terminal builds are picked up automatically.** If the user runs
  `colcon build` outside VS Code, the per-package
  `build/<pkg>/compile_commands.json` files are merged in memory and watched;
  the manual "Merge compile_commands.json" command is no longer required to get
  the new defines, includes and `-std`.
- **Sibling source dependencies resolve before a build.** Declared dependencies
  that live in the same workspace contribute `<ws>/src/<dep>/include` (or
  `<repo>/<dep>/include`), but only when they follow the ROS header layout, so
  loose headers cannot shadow system headers again. Generated interfaces still
  require a build.
- **Setup is less destructive.** `Set Up Workspace for IntelliSense` no longer
  overwrites an existing `compileCommands` entry, and its fallback paths now
  cover `include/` and direct-package layouts.
- **"Build My Packages" works without `src/<user>`.** It uses `src/<user>` when
  present, then `src`, then the workspace root, so package-at-root and
  direct-package repos no longer fail the command.
- 32 unit tests and an expanded smoke test cover the new layouts.

## 0.1.6

- **ROS 2 install discovery is no longer hardcoded to `/opt/ros`.** The prefix
  and distro now come from `ros2IntelliSense.rosPrefix`, `ROS_DISTRO`,
  `.ros-intellisense.env`, `AMENT_PREFIX_PATH`, `COLCON_PREFIX_PATH`,
  `CONDA_PREFIX`, and only then `/opt/ros`. RoboStack/conda, Docker/Dev
  Containers, source builds and custom prefixes now resolve `rclcpp/...` and can
  be built. The silent `jazzy` fallback is gone: when nothing is found the
  provider still serves the package/compile-commands paths and the build says so
  instead of pretending a distro is installed.
- **Architecture- and compiler-aware `intelliSenseMode`.** arm64 (Jetson,
  Raspberry Pi) and clang (`linux-clang-*`, `macos-clang-*`) are recognised
  instead of always assuming `linux-gcc-x64`. Compiler detection now honours
  `$CXX` and `PATH`, so conda/Nix toolchains are found too.
- **Per-file language standard.** The provider forwards the file's own `-std=`
  from `compile_commands.json` (normalising aliases such as `gnu++2b`), falling
  back to `gnu17` for `.c` and `gnu++17` for C++ instead of applying `gnu++17`
  to every file. Projects built with C++14/20/23 are parsed with the standard
  they are actually compiled with.
- **The build command sources the detected prefix**, not `/opt/ros/<distro>`.
  Conda environments without a prefix-level `setup.bash` fall back to the
  environment VS Code was started from.

## 0.1.5

- **Forward the real compile flags.** The provider now passes the `-D` defines
  from the file's own entry in `compile_commands.json` (EIGEN_*, BOOST_*, QT_*,
  `DEFAULT_RMW_IMPLEMENTATION`, `NDEBUG`, …) instead of `defines: []`. Macros
  change which code is active, so completion and diagnostics now match what the
  compiler actually sees. Files without an entry (headers, or a workspace that
  has not been built) still get no defines, as before.
- **Fixed the command tokenizer swallowing flags after an escaped-quote define.**
  CMake emits defines such as `-DROS_PACKAGE_NAME=\"my_pkg\"`; the escaped quote
  used to open a string and hide every following `-I`/`-D` on that line. Both the
  include extraction and the new define extraction now see them.

## 0.1.4

- **Fixed C++ IntelliSense breaking whenever the provider was active.** With the
  provider selected you would see `namespace "std" has no member "make_shared"`
  / `"chrono_literals"`, `std::hypot`, `using X = Y;` reported as a syntax error,
  and then a cascade of `expected a declaration` — the classic look of a
  pre-C++11 parse. The real cause was the per-package ROS include roots added in
  0.1.2: they covered **every** installed package, but not every package follows
  the ROS `include/<pkg>/<pkg>/...` layout. Some (lely, osqp, ouster, depthai,
  ur_client_library, …) drop loose headers straight into `include/<pkg>/`. With
  those directories on the include path, `lely/features.h` matched glibc's
  `<features.h>` first, which broke `<c++config.h>` and brought down the whole
  C++ standard library with it. Roots are now limited to directories that
  contain a nested `<pkg>/`, so stray package headers can no longer shadow
  system headers. It was never a C++ standard problem — the code and `gnu++17`
  were fine.

## 0.1.3

- **Respect the compiler chosen for the C/C++ extension.** When
  `ros2IntelliSense.compilerPath` is empty the provider now falls back to
  `C_Cpp.default.compilerPath` before any platform default, so an active
  configuration provider no longer silently overrides your compiler. The
  platform default also prefers the C++ driver (`/usr/bin/g++`, `clang++`) over
  the bare C driver, which is what supplies the C++ standard library include
  paths and a modern `__cplusplus`.
- Reload workspaces (not just caches) when `ros2IntelliSense.*` or
  `C_Cpp.default.compilerPath` changes, so a changed compiler or distro takes
  effect immediately.

## 0.1.2

- **Fixed ROS headers not resolving** (`cannot open source file "rclcpp/rclcpp.hpp"`,
  `geometry_msgs/msg/twist.hpp`, …). The include path previously used a single
  non-recursive `/opt/ros/<distro>/include` root, but ROS headers are addressed
  with their package prefix and live at `include/<pkg>/<pkg>/...`, so the
  resolvable root is `include/<pkg>`. The resolver now enumerates one
  non-recursive root per installed ROS package (`rosPackageIncludeRoots`),
  cached per distro. This makes IntelliSense work even before a build, without
  falling back to the old recursive `/**` scan.
- **Support colcon workspaces nested inside the opened folder.** If the folder
  you open is not itself a colcon root (for example a repo that keeps its
  workspace in `<repo>/mobile/`), the extension now discovers nested roots
  (bounded depth, pruning `build/`, `install/`, `log/`, packages, dot-dirs) and
  picks the nearest root per file. Previously the extension detected no
  workspace at all in that layout and stayed inactive.

## 0.1.1

- **Fixed a crash on activation** (`ReferenceError: Cannot access 'exports' before
  initialization`): a local variable in `getCppToolsApi` shadowed CommonJS's
  `exports`, so the extension failed to activate and registered no commands.
- Added a headless activation smoke test (`npm run smoke`) that loads the
  compiled extension with a stubbed `vscode` module against a real temporary
  workspace, so this class of bug is caught without launching VS Code.

## 0.1.0

- Converted the drop-in shell script into a VS Code extension.
- Added a C/C++ **Custom Configuration Provider** that injects the active ROS 2
  package and its `package.xml` dependencies into IntelliSense.
- **Performance-first include paths:** concrete, non-recursive directories only
  (no `${workspaceFolder}/**`); lazy/cached package lookup; background, mtime-
  guarded `compile_commands.json` parsing; debounced watchers; `browse` index
  limited to `src/**` and disableable via `enableWorkspaceSymbolSearch`.
- Added `includeMode` (`package` | `workspace`) to opt back into the old broad scan.
- Added a status-bar item showing the active package.
- Re-implemented `colcon build` and `compile_commands.json` merging in TypeScript.
- Added commands: build workspace/package/mine, merge, refresh, show package,
  set up workspace, select distro.
- Kept `ros_int.sh` for headless/CI use.
