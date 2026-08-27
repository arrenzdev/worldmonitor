# Managed OSINT Suite runtime

The Windows desktop installer can bundle Velocity, IRONSIGHT, and Shadowbroker
as managed loopback services. The generated payload lives under `runtime/` and
is intentionally ignored by Git; `scripts/build-osint-suite-runtime.mjs`
reproduces it from the pinned upstream commits in `bundle-manifest.json`.

At runtime the Tauri process:

1. starts Velocity with the bundled Python runtime and its built web assets;
2. starts the IRONSIGHT standalone Next.js server with World Monitor's bundled
   Node runtime;
3. starts Shadowbroker's bundled Python backend and the loopback-only static
   host/proxy in `managed-host.mjs`;
4. publishes only OS-assigned `127.0.0.1` ports to the renderer; and
5. terminates every managed process when World Monitor exits.

Velocity retains its original `apps/` and `tools/` layout so its Python process
can resolve the bundled browser-feed sidecars. A single packaged Chromium and
the ADS-B feeder's Playwright installation are shared by the aviation, maritime,
and generic browser helpers.

Non-Windows packages retain the existing Docker/remote-endpoint path. A missing
or incomplete generated payload is reported as unavailable and never causes the
main World Monitor desktop process to fail.
