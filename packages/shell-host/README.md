# zai-pp-shell-host

Native Messaging Shell MCP host installer for Zai++.

The host gives the extension a `shell_exec` / `local_file_*` capability by running a
small Node.js process on the local machine and talking to it over Chrome's Native
Messaging channel.

## Install

From a checkout of the repository:

```bash
npm run shell:install -- --browser chrome --extension-id <extension-id>
```

`--extension-id` is the 32-character ID of the loaded extension
(`chrome://extensions` → Zai++ → ID). It is required: the generated Native Messaging
manifest whitelists exactly that origin. The side panel's MCP page fills in the
current ID for you.

`--browser` accepts `chrome`, `chromium`, or `edge` (default: `chrome`).

## Other commands

```bash
npm run shell:install -- status --browser chrome
npm run shell:install -- uninstall --browser chrome
```

`install` writes the Native Messaging manifest and copies the host runtime into the
user's profile directory (on Windows it also writes the `HKCU` registry key). No
administrator rights are required.

## Optional: log file

Pass `--log-file <path>` to have the host wrapper redirect its stderr there:

```bash
npm run shell:install -- --browser chrome --extension-id <id> --log-file "$HOME/zai-host.log"
```