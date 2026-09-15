#!/usr/bin/env bash
# =============================================================================
# setup.sh — One-shot setup for ROS build + VS Code IntelliSense
# =============================================================================
# Detects platform (Linux / macOS / WSL) and ROS distro automatically.
# Generates .ros-intellisense.env config + .vscode/ IntelliSense config.
#
# Usage:
#   cd ~/robotica_ws && /path/to/setup.sh
#   /path/to/setup.sh /path/to/workspace
#   /path/to/setup.sh --distro humble    # override ROS distro
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE=".ros-intellisense.env"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { echo -e "\033[0;36m$*\033[0m"; }
ok()    { echo -e "\033[0;32m$*\033[0m"; }
warn()  { echo -e "\033[1;33m$*\033[0m"; }
err()   { echo -e "\033[0;31m$*\033[0m" >&2; }

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
OVERRIDE_DISTRO=""
WS=""

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)
            cat <<'EOF'
setup.sh — One-shot ROS IntelliSense setup

Usage:
  ./setup.sh                        # setup current directory
  ./setup.sh /path/to/workspace     # setup specific workspace
  ./setup.sh --distro humble        # override ROS distro

Options:
  -d, --distro DISTRO   Force ROS distro (e.g. humble, jazzy, rolling)
  -h, --help            Show this help
EOF
            exit 0
            ;;
        -d|--distro)  OVERRIDE_DISTRO="$2"; shift 2 ;;
        -*)           err "Unknown option: $1"; exit 1 ;;
        *)            WS="$1"; shift ;;
    esac
done

WS="${WS:-$PWD}"

if [ ! -d "$WS" ]; then
    err "Workspace not found: $WS"
    exit 1
fi

cd "$WS" || exit 1
info "Setting up in: $WS"

# =============================================================================
# PLATFORM DETECTION
# =============================================================================
detect_platform() {
    local os="$(uname -s)"
    local wsl=0

    # Check for WSL (only on Linux)
    if [ "$os" = "Linux" ] && [ -f /proc/version ]; then
        if grep -qiE '(microsoft|wsl)' /proc/version 2>/dev/null; then
            wsl=1
        fi
    fi

    case "$os" in
        Linux)
            if [ "$wsl" -eq 1 ]; then
                echo "wsl"
            else
                echo "linux"
            fi
            ;;
        Darwin)  echo "macos" ;;
        MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
        *)       echo "unknown" ;;
    esac
}

PLATFORM="$(detect_platform)"
info "Detected platform: $PLATFORM"

# =============================================================================
# ROS DISTRO DETECTION
# =============================================================================
detect_ros_distro() {
    # 1. Use override if provided
    if [ -n "$OVERRIDE_DISTRO" ]; then
        echo "$OVERRIDE_DISTRO"
        return
    fi

    # 2. Check if ROS_DISTRO is already set
    if [ -n "${ROS_DISTRO:-}" ]; then
        echo "$ROS_DISTRO"
        return
    fi

    # 3. Auto-detect from /opt/ros/
    if [ -d "/opt/ros" ]; then
        # Find the highest version directory
        local distro
        distro="$(ls -1 /opt/ros/ 2>/dev/null | sort -V | tail -1)"
        if [ -n "$distro" ]; then
            echo "$distro"
            return
        fi
    fi

    # 4. Try sourcing common locations
    for setup_file in \
        /opt/ros/jazzy/setup.bash \
        /opt/ros/humble/setup.bash \
        /opt/ros/iron/setup.bash \
        /opt/ros/rolling/setup.bash \
        "$HOME/ros2_ws/install/setup.bash"; do
        if [ -f "$setup_file" ]; then
            # Extract distro name from path
            basename "$(dirname "$setup_file")"
            return
        fi
    done

    # 5. Fallback
    echo "jazzy"
}

ROS_DISTRO_DETECTED="$(detect_ros_distro)"
info "Detected ROS distro: $ROS_DISTRO_DETECTED"

# =============================================================================
# COMPILER DETECTION
# =============================================================================
detect_compiler() {
    case "$PLATFORM" in
        macos)
            if [ -f "/opt/homebrew/bin/gcc-14" ]; then
                echo "/opt/homebrew/bin/gcc-14"
            elif [ -f "/opt/homebrew/bin/gcc-13" ]; then
                echo "/opt/homebrew/bin/gcc-13"
            elif command -v gcc >/dev/null 2>&1; then
                command -v gcc
            else
                echo "/usr/bin/clang"
            fi
            ;;
        *)
            if command -v gcc >/dev/null 2>&1; then
                command -v gcc
            else
                echo "/usr/bin/gcc"
            fi
            ;;
    esac
}

COMPILER_PATH="$(detect_compiler)"
info "Detected compiler: $COMPILER_PATH"

# =============================================================================
# ROS INCLUDE PATH DETECTION
# =============================================================================
detect_ros_include() {
    local ros_base="/opt/ros/$ROS_DISTRO_DETECTED"
    local include_path=""

    if [ -d "$ros_base/include" ]; then
        include_path="$ros_base/include/**"
    elif [ -d "$ros_base" ]; then
        # Some installs put headers in different locations
        include_path="$ros_base/**"
    fi

    echo "$include_path"
}

ROS_INCLUDE="$(detect_ros_include)"

# =============================================================================
# GENERATE CONFIG FILE
# =============================================================================
generate_config() {
    local config_path="$WS/$CONFIG_FILE"

    cat > "$config_path" <<CONF
# ROS IntelliSense configuration
# Generated by setup.sh on $(date -Iseconds)

ROS_DISTRO=$ROS_DISTRO_DETECTED
PLATFORM=$PLATFORM
COMPILER_PATH=$COMPILER_PATH
ROS_INCLUDE=$ROS_INCLUDE
PARALLEL_WORKERS=4
MINE_BASE_PATH=src/mine
CONF

    ok "  → $config_path"
}

# Always regenerate config (it's the source of truth)
info "Generating config..."
generate_config

# =============================================================================
# INSTALL build.sh
# =============================================================================
info "Installing build.sh..."
cp "$SETUP_DIR/build.sh" "$WS/build.sh"
chmod +x "$WS/build.sh"
ok "  → $WS/build.sh"

# =============================================================================
# CREATE .vscode/
# =============================================================================
info "Configuring VS Code..."
mkdir -p "$WS/.vscode"

# --- c_cpp_properties.json ---
CPP_PROPS="$WS/.vscode/c_cpp_properties.json"
if [ -f "$CPP_PROPS" ]; then
    warn "  c_cpp_properties.json already exists — skipping."
else
    cat > "$CPP_PROPS" <<CCEOF
{
  "configurations": [
    {
      "name": "ROS",
      "includePath": [
        "\${workspaceFolder}/**",
        "$ROS_INCLUDE",
        "/opt/ros/*/include/**"
      ],
      "defines": [],
      "compilerPath": "$COMPILER_PATH",
      "cStandard": "c17",
      "cppStandard": "gnu++17",
      "intelliSenseMode": "linux-gcc-x64",
      "compileCommands": "\${workspaceFolder}/build/compile_commands.json"
    }
  ],
  "version": 4
}
CCEOF
    ok "  → $CPP_PROPS"
fi

# --- tasks.json ---
TASKS_FILE="$WS/.vscode/tasks.json"
if [ -f "$TASKS_FILE" ]; then
    warn "  tasks.json already exists — skipping."
else
    cat > "$TASKS_FILE" <<'TASKEOF'
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "ROS: Build & Merge IntelliSense",
      "type": "shell",
      "command": "${workspaceFolder}/build.sh",
      "args": [],
      "group": {
        "kind": "build",
        "isDefault": true
      },
      "problemMatcher": ["$gcc"],
      "detail": "Build all packages and merge compile_commands.json"
    },
    {
      "label": "ROS: Build (specific package) & Merge IntelliSense",
      "type": "shell",
      "command": "${workspaceFolder}/build.sh",
      "args": ["--packages-select", "${input:packageName}"],
      "group": "build",
      "problemMatcher": ["$gcc"],
      "detail": "Build a specific ROS package and merge compile_commands.json"
    },
    {
      "label": "ROS: Reset IntelliSense Database",
      "type": "shell",
      "command": "touch",
      "args": ["${workspaceFolder}/build/compile_commands.json"],
      "group": "none",
      "detail": "Touch the merged compile_commands.json to trigger C/C++ reload"
    }
  ],
  "inputs": [
    {
      "id": "packageName",
      "type": "promptString",
      "description": "ROS package name to build",
      "default": ""
    }
  ]
}
TASKEOF
    ok "  → $TASKS_FILE"
fi

# =============================================================================
# ENSURE build/ DIRECTORY
# =============================================================================
mkdir -p "$WS/build"
touch "$WS/build/compile_commands.json"

# =============================================================================
# SUMMARY
# =============================================================================
echo ""
ok "=========================================="
ok " Setup complete!"
ok "=========================================="
echo ""
echo "  Platform:   $PLATFORM"
echo "  ROS distro: $ROS_DISTRO_DETECTED"
echo "  Compiler:   $COMPILER_PATH"
echo "  Workspace:  $WS"
echo ""
echo "  Installed files:"
echo "    $CONFIG_FILE           — auto-detected config"
echo "    build.sh               — build + merge (self-contained)"
echo "    .vscode/c_cpp_properties.json"
echo "    .vscode/tasks.json"
echo ""
echo "  Quick start:"
echo "    cd $WS"
echo "    ./build.sh                         # build all + merge"
echo "    ./build.sh -m                      # build only my folder"
echo "    ./build.sh --packages-select pkg   # build one package"
echo ""
echo "  VS Code:"
echo "    Ctrl+Shift+B         → build all packages"
echo "    Ctrl+Shift+P → Tasks → ROS: Build (specific package)"
echo ""
echo "  To change ROS distro:"
echo "    ./setup.sh --distro humble"
echo ""
echo "  IntelliSense not working?"
echo "    Ctrl+Shift+P → C/C++: Reset IntelliSense Database"
echo ""
