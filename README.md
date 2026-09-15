# ROS IntelliSense Setup

One-shot setup for ROS workspace build + VS Code IntelliSense.
Auto-detects platform and ROS distro.

## Platform compatibility

| Platform | Status | Notes |
|----------|--------|-------|
| **Linux (Ubuntu/Debian)** | ✅ Full support | Primary target |
| **WSL2 (Windows)** | ✅ Full support | Auto-detected via /proc/version |
| **macOS (Apple Silicon/Intel)** | ✅ Full support | Auto-detects Homebrew gcc |
| **Windows native** | ❌ Not supported | Use WSL2 instead |

## Quick start

```bash
cd ~/robotica_ws
/path/to/setup.sh
```

This auto-detects your platform and ROS distro, then installs:
- `.ros-intellisense.env` — detected config (distro, platform, compiler)
- `build.sh` — build + merge (self-contained)
- `.vscode/` — IntelliSense config + build tasks

## One-shot setup

```bash
# Auto-detect everything
./setup.sh

# Specify workspace
./setup.sh ~/robotica_ws

# Override ROS distro
./setup.sh --distro humble
./setup.sh -d rolling
```

## Configuration

`setup.sh` generates `.ros-intellisense.env` with detected values:

```bash
ROS_DISTRO=jazzy
PLATFORM=linux
COMPILER_PATH=/usr/bin/gcc
ROS_INCLUDE=/opt/ros/jazzy/include/**
PARALLEL_WORKERS=4
MINE_BASE_PATH=src/user
```

Edit this file to override any setting. `build.sh` reads it on every run.

## Daily usage

### Terminal

```bash
./build.sh                           # build all packages
./build.sh -m                        # build only src/user
./build.sh -c                        # build current directory
./build.sh -m -c                     # build src/user in current dir
./build.sh /path/to/ws               # build a specific workspace
./build.sh --packages-select my_pkg  # build a single package
./build.sh --no-merge                # build only, skip merge
```

### VS Code

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+B` | Build all + merge IntelliSense |
| `Ctrl+Shift+P` → **Tasks: Run Task** | Build specific package |
| `Ctrl+Shift+P` → **C/C++: Reset IntelliSense Database** | Force refresh |

## How it works

1. `setup.sh` detects platform + ROS distro → generates `.ros-intellisense.env`
2. `build.sh` reads config, runs `colcon build` with `CMAKE_EXPORT_COMPILE_COMMANDS=ON`
3. `build.sh` merges all `build/*/compile_commands.json` (inline Python, no deps)
4. VS Code C/C++ extension reads the merged database for IntelliSense

## Architecture

```
setup.sh                  # One-shot installer (run once)
build.sh                  # Self-contained build + merge (run every time)
.ros-intellisense.env     # Auto-detected config (distro, platform, compiler)
.vscode/
  c_cpp_properties.json   # Points IntelliSense at merged DB
  tasks.json              # Build tasks for Ctrl+Shift+B
build/
  compile_commands.json   # Merged IntelliSense database (auto-generated)
```

## Platform-specific behavior

### Linux / WSL2
- Compiler: `/usr/bin/gcc`
- ROS path: `/opt/ros/{distro}/include/**`
- Build args: standard colcon flags

### macOS
- Compiler: auto-detected (`/opt/homebrew/bin/gcc-14` → `/usr/bin/clang`)
- ROS path: `/opt/ros/{distro}/include/**`
- Build args: adds `-DCMAKE_PREFIX_PATH=/opt/homebrew` if Homebrew detected

## Integration with rosbuild

`build.sh` supports the same flags as the `rosbuild()` shell function:

- `-c / --current` — force build in current directory
- `-m / --mine` — build only packages under `src/user`
- Workspace auto-detection (current dir > `ROSWORKSPACE` > default)

You can replace the `rosbuild()` function in your `.bashrc` with a simple alias:

```bash
alias rosbuild='~/robotica_ws/build.sh'
```

## Troubleshooting

- **IntelliSense not updating**: `Ctrl+Shift+P` → **C/C++: Reset IntelliSense Database**
- **Wrong ROS distro detected**: run `./setup.sh --distro humble` to override
- **No compile_commands.json**: ensure your package has `ament_cmake` in its `package.xml`
- **Build fails**: check that ROS is sourced (`source /opt/ros/{distro}/setup.bash`)
