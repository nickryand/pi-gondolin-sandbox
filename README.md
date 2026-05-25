# Gondolin Sandbox Extension for pi

This extension provides a sandboxed execution environment for the `pi` coding agent using **Gondolin** (a micro-VM runner). It intercepts standard file and shell tools and redirects their execution into an isolated **Alpine Linux** virtual machine.

## Overview

The core purpose of this extension is to provide isolation for potentially destructive or complex operations. By running commands inside a micro-VM, the agent's actions are contained within a controlled environment, even though the files being manipulated are part of your host project.

The directory you start `pi` in is mounted read-write at `/workspace/<project-folder-name>` inside the VM. Additional project-specific mounts can be configured in a `.gondolin.json` file in the project directory, including other mounts under `/workspace`.

## How it Works

The extension overrides pi's built-in `read`, `write`, `edit`, and `bash` tools with custom implementations:

### 1. Tool Redirection
*   **`read` Tool**: Instead of reading from the host disk, it uses the VM to run `/bin/cat <guest_path>`. It also uses the `file` command inside the guest to detect MIME types for image processing.
*   **`write` Tool**: To safely write data without shell-escaping issues, it uses a **Base64 roundtrip**. It encodes the content to Base64, sends it to the VM, and uses `base64 -d` inside the guest to reconstruct the file. It also automatically performs `mkdir -p` for the target directory.
*   **`edit` Tool**: Acts as a wrapper that leverages the custom `read` and `write` operations.
*   **`bash` Tool**: Intercepts bash commands and executes them via `/bin/bash -lc "<command>"` inside the VM, handling environment variables, timeouts, and stdout/stderr streams.

### 2. Path Mapping & Security
The extension implements a mapping layer between the host filesystem and the VM:
*   **`toGuestPath`**: Translates absolute host paths (e.g., `/home/user/project/file.txt`) into guest paths (e.g., `/workspace/project/file.txt`).
*   **Sandbox Escape Prevention**: The mapping logic explicitly prevents directory traversal attacks by erroring if a path attempts to use `..` to escape the project directory.
*   **Shell Quoting**: All paths and strings passed to the VM are passed through a `shQuote` utility to prevent command injection via the shell.

### 3. Agent Context Awareness
To ensure the AI agent remains "aware" of its environment, the extension:
*   **Updates System Prompts**: Before the agent starts, the extension modifies the system prompt to replace the host's current working directory with the guest's `/workspace/<project-folder-name>` path.
*   **Lazy VM Initialization**: The VM is started on demand (at `session_start` or when the first tool is called) to conserve resources.

## Project settings

Create a JSON `.gondolin.json` file in the project directory to set the VM image tag, add more RealFS mounts, and configure limited network access:

```json
{
  "image": {
    "tag": "pi-sandbox:latest"
  },
  "mounts": {
    "/cache": "./.cache",
    "/readonly-data": {
      "path": "../shared-data",
      "readOnly": true
    },
    "/extra": {
      "hostPath": "/var/tmp/gondolin-extra",
      "options": {
        "readOnly": false
      }
    }
  },
  "network": {
    "allowHosts": ["api.github.com", "*.npmjs.org"],
    "tcpMap": {
      "postgres.local:5432": "127.0.0.1:5432",
      "redis.local": "127.0.0.1:6379"
    },
    "panel": false
  }
}
```

Use `image.tag` (or top-level `imageTag`) to select the Gondolin image for the sandbox. Before the VM starts, the extension checks the local image store through the Gondolin SDK. If the image is missing and the project contains `Gondolinfile`, it builds the image through the SDK using that file as the build configuration, imports the result into the local image store, and tags it with the configured tag. Build metadata is stored in `.gondolin/image-build.json`; if the `Gondolinfile` modification time is newer than that metadata, the image is rebuilt. If a rebuild happens while a VM is already running, pi will prompt you to run `/gondolin reload` so the VM starts using the new image.

Mount keys are absolute guest paths. Values may be a host path string or an object with `path`, `hostPath`, or `root`. Relative host paths are resolved from the project directory. All other fields, plus nested `options`, are passed through to Gondolin's `RealFSProvider` options.

`network.allowHosts` mirrors Gondolin's `--allow-host` HTTP policy. Omit it to leave HTTP unrestricted, or set it to an empty array to deny all HTTP hosts. `network.tcpMap` mirrors Gondolin's `--tcp-map` and maps guest `HOST[:PORT]` names to upstream `HOST:PORT` endpoints; TCP mapping automatically enables synthetic per-host DNS inside Gondolin. Set `network.panel` to `true` to show the network event panel automatically at session start, or leave it `false` and toggle it manually.

## Commands

* `/gondolin build` force-builds the configured image from `Gondolinfile`. If the VM is running, reload it afterwards with `/gondolin reload`.
* `/gondolin reload` re-reads `.gondolin.json`, stops the current VM, and starts it again with the updated image, mount, and network settings.
* `/gondolin panel` toggles a right-side overlay with recent HTTP allow-host and TCP map allow/deny events.

Add `.gondolin/` to your project `.gitignore` to ignore the build metadata cache.

## Requirements

*   **Gondolin**: The micro-VM runner must be installed and configured.
*   **QEMU**: Required by Gondolin for virtualization.
*   **Alpine Linux Image**: The environment relies on an Alpine-based guest for tool availability (like `cat`, `file`, `base64`, etc.).

## Usage

Install the package from pi configuration (global or project-local):

```bash
pi install /absolute/path/to/pi-gondolin
# or, from a project, write to .pi/settings.json:
pi install -l /absolute/path/to/pi-gondolin
```

This works because `package.json` declares the conventional extension tree under `pi.extensions`:

```text
pi-gondolin/
├── package.json
├── extensions/
│   └── pi-gondolin/
│       └── index.ts
└── ...
```

Equivalent settings JSON:

```json
{
  "packages": ["/absolute/path/to/pi-gondolin"]
}
```

Then start pi in the project you want to sandbox:

```bash
cd /path/to/your/project
pi
```

You can also test it without installing by passing the package directory directly:

```bash
cd /path/to/your/project
pi -e /absolute/path/to/pi-gondolin
```
