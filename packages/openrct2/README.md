# @gamebot/openrct2

Connection to a **separately installed** [openrct2-bridge](https://github.com/MaukWM/openrct2-bridge) plugin. OpenRCT2 and its game files are not bundled with Gamebot. The native OpenRCT2 window displays the park while the bridge reads state and sends actions.

Load a park in OpenRCT2 with the plugin active. Find its listening port in the OpenRCT2 console (the plugin starts at 20020). From this workspace, run `npm run play -w @gamebot/openrct2 -- --port=20020` to read status and cash. Add `--pause` to send a pause action through `SessionRuntime`. The result is `success` only if the plugin's `get_status` response reports `paused: true`; otherwise verification is `unknown`, not assumed successful. This is a narrow connection smoke test, not a park-playing policy.

The exported `OpenRct2Bridge` satisfies Gamebot's `GameAdapter` interface; callers supply game-specific candidate generation and verification for their own park goals.
