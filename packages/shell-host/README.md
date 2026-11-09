# zai-pp-shell-host

Native Messaging Shell MCP host installer for Zai++.

The host gives the extension a `shell_exec` / `local_file_*` capability by running a
small Node.js process on the local machine and talking to it over the Native
Messaging channel.

## Install

```bash
npx --yes zai-pp-shell-host install --browser <chrome|edge|chromium> --extension-id <extension-id>
```

`--extension-id` is the 32-character ID of the loaded extension
(`chrome://extensions` → Zai++ → ID). It is required: the generated Native Messaging
manifest whitelists exactly that origin. The side panel's MCP page fills in the
current ID for you.

`--browser` accepts `chrome`, `chromium`, or `edge` (default: `chrome`).

`--yes` skips npx's one-time "Ok to proceed?" prompt. The npm package is only a
carrier: `install` copies the host runtime into your profile directory, so you can
remove the global package afterwards without affecting the installed host.

### From a repository checkout

```bash
npm run shell:install -- install --browser <chrome|edge|chromium> --extension-id <extension-id>
```

## Other commands

```bash
npx --yes zai-pp-shell-host status --browser <chrome|edge|chromium>
npx --yes zai-pp-shell-host uninstall --browser <chrome|edge|chromium>
```

`install` writes the Native Messaging manifest and copies the host runtime into the
user's profile directory (on Windows it also writes the `HKCU` registry key). No
administrator rights are required.

## Optional: log file

Pass `--log-file <path>` to have the host wrapper redirect its stderr there:

```bash
npx --yes zai-pp-shell-host install --browser chrome --extension-id <id> --log-file "$HOME/zai-host.log"
```