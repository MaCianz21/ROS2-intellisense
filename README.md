# ROS IntelliSense — Drop-in Build Script

One file. Zero config. Just copy and run.

## Quick start

```bash
# Copy build.sh into any ROS workspace
cp build.sh ~/my_ros_ws/

# Run it — auto-detects platform, distro, sets up IntelliSense
cd ~/my_ros_ws && ./build.sh
```

## What it does

1. **Auto-detects** platform (Linux/WSL/macOS), ROS distro, compiler
2. **Auto-generates** `.ros-intellisense.env` config + `.vscode/` if missing
3. **Builds** with `colcon build` + `CMAKE_EXPORT_COMPILE_COMMANDS=ON`
4. **Merges** all `compile_commands.json` for VS Code IntelliSense

## Platform compatibility

| Platform | Status |
|----------|--------|
| Linux (Ubuntu/Debian) | ✅ |
| WSL2 | ✅ auto-detected |
| macOS (Apple Silicon/Intel) | ✅ auto-detects Homebrew gcc |
| Windows native | ❌ use WSL2 |

## Usage

```bash
./build.sh                           # build all + merge
./build.sh -m                        # build only src/<user>
./build.sh -c                        # build current directory
./build.sh -m -c                     # build src/<user> in current dir
./build.sh /path/to/ws               # build specific workspace
./build.sh --packages-select my_pkg  # build one package
./build.sh --no-merge                # build only, skip merge
./build.sh --distro humble           # override ROS distro
./build.sh --help                    # show all options
```

### VS Code

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+B` | Build all + merge IntelliSense |
| `Ctrl+Shift+P` → Tasks | Build specific package |
| `Ctrl+Shift+P` → C/C++: Reset IntelliSense Database | Force refresh |

## Configuration

First run generates `.ros-intellisense.env`:

```bash
ROS_DISTRO=jazzy
PLATFORM=linux
COMPILER_PATH=/usr/bin/gcc
ROS_INCLUDE=/opt/ros/jazzy/include/**
PARALLEL_WORKERS=4
MINE_BASE_PATH=src/macianz
```

Edit this file to override any setting. Delete it to re-detect.

## How it works

```
build.sh                    ← copy this single file anywhere
.ros-intellisense.env       ← auto-generated (edit to override)
.vscode/
  c_cpp_properties.json     ← auto-generated
  tasks.json                ← auto-generated
build/
  compile_commands.json     ← merged IntelliSense database
```

## Integration with rosbuild

Same flags as the `rosbuild()` shell function:

- `-c / --current` — force build in current directory
- `-m / --mine` — build only packages under `src/<user>`
- Workspace auto-detection (current dir > `ROSWORKSPACE` > default)

```bash
# Replace rosbuild() with a simple alias
alias rosbuild='~/robotica_ws/build.sh'
```

## Troubleshooting

- **IntelliSense not updating**: `Ctrl+Shift+P` → C/C++: Reset IntelliSense Database
- **Wrong distro**: `./build.sh --distro humble` (regenerates config)
- **No compile_commands.json**: package needs `ament_cmake` in `package.xml`
- **Build fails**: ensure ROS is sourced (`source /opt/ros/{distro}/setup.bash`)
