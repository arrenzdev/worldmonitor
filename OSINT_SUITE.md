# OSINT Suite

World Monitor can host three independent OSINT applications in its **OSINT Suite** panel. The integration is intentionally isolated: it does not replace World Monitor services, panels, data stores, or default Compose behavior.

## Windows desktop: one installer, no Docker

The Windows x64 MSI/NSIS package includes pinned builds of Velocity, IRONSIGHT,
and Shadowbroker together with private Python, Node.js, and Chromium runtimes.
Installing Docker, Node.js, or Python separately is not required.

When the World Monitor desktop app starts, its native process manager launches
all three tools on dynamically selected `127.0.0.1` ports. The OSINT Suite panel
is available by default in the desktop layout, resolves those ports through the
native bridge, and opens Velocity automatically. Switching tabs opens the other
tools inside the same panel. Closing World Monitor terminates the entire managed
process tree.

The first start can take up to 150 seconds while the data providers and browser
feeds warm up. A provider that requires its own API key remains unavailable until
that key is configured, but the other applications continue running.

To assemble an unsigned Windows installer from source on Windows x64:

```powershell
npm ci
npm run desktop:package:windows
```

The packaging command fetches the three upstream projects at the full commits
recorded in `src-tauri/osint-suite/bundle-manifest.json`, builds their production
assets, creates the private runtime, and then emits the normal World Monitor MSI
and NSIS installers.

## Docker/self-hosted mode

First complete the normal steps in [SELF_HOSTING.md](SELF_HOSTING.md), including the required `.env` secrets. Then run:

```bash
docker compose -f docker-compose.yml -f docker-compose.osint-suite.yml up -d --build
```

Open `http://localhost:3000`, choose **Panels → Intelligence → OSINT Suite**, and enable it. The fixed Docker endpoints are:

| Tool | Endpoint | Included capabilities |
| --- | --- | --- |
| Velocity | `http://127.0.0.1:3101` | Historical replay, evidence provenance, investigations, graphs and reports |
| IRONSIGHT | `http://127.0.0.1:3102` | Conflict theaters, alerts, military tracking, markets and crisis intelligence |
| Shadowbroker | `http://127.0.0.1:3103` | Recon, aviation, maritime, space, infrastructure, hazards and Time Machine |

Only one tool iframe is mounted at a time. Closing or disabling the panel unloads it. Use **Configure** in the panel to point any tool at an HTTPS deployment instead.

Stop only the optional services without removing stored data:

```bash
docker compose -f docker-compose.yml -f docker-compose.osint-suite.yml stop \
  velocity velocity-api velocity-web-build ironsight \
  shadowbroker shadowbroker-frontend shadowbroker-backend
```

## Security boundary

- The three browser endpoints bind to `127.0.0.1`; do not change them to `0.0.0.0` without adding authentication and reviewing the upstream security models.
- Velocity compute routes run in its documented local `ALLOW_UNAUTHENTICATED` mode. They are reachable only through the loopback-bound proxy.
- Shadowbroker normally sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`. The local `shadowbroker` bridge replaces only those framing restrictions and permits World Monitor origins on loopback. The upstream frontend/backend are not published to the host.
- Remote configured endpoints must use HTTPS. Plain HTTP is accepted only for `localhost` and `127.0.0.1`.
- Some Shadowbroker data sources are intentionally opt-in because enabling them contacts sensitive or commercial upstreams. Set their documented `*_ENABLED=true` values in `.env` only after reviewing the privacy impact.

## Optional credentials

The overlay reuses common World Monitor values such as `FINNHUB_API_KEY`, `NASA_FIRMS_API_KEY`, `AISSTREAM_API_KEY`, OpenSky credentials, and `CLOUDFLARE_API_TOKEN`. It also recognizes tool-specific values including `SHADOWBROKER_ADMIN_KEY`, `GFW_API_TOKEN`, `LTA_ACCOUNT_KEY`, `AIRFRAMES_API_KEY`, `DEEPSEEK_API_KEY`, `NVIDIA_API_KEY`, `CDSE_CLIENT_ID`, and `CDSE_CLIENT_SECRET`. Missing keys degrade the corresponding upstream feature rather than changing World Monitor defaults.

## Upstream projects and licenses

This integration runs upstream container images or pinned upstream builds; it does not relicense them.

| Project | Upstream | License | Integration form |
| --- | --- | --- | --- |
| Velocity | [AndrewCTF/velocity](https://github.com/AndrewCTF/velocity) | AGPL-3.0 | Published API/web images or pinned Windows build |
| IRONSIGHT | [NoblerWorks-HQ/IRONSIGHT](https://github.com/NoblerWorks-HQ/IRONSIGHT) | MIT | Source build pinned to `2e7005cf7eef191cbad55bc5fca09c19e77d7b84` |
| Shadowbroker | [BigBodyCobain/Shadowbroker](https://github.com/BigBodyCobain/Shadowbroker) | AGPL-3.0 | Published images or pinned Windows build |

World Monitor is AGPL-3.0-only. Making a repository private does not remove AGPL obligations when a modified AGPL service is provided to other users over a network; retain notices and provide the corresponding source as required by each upstream license.
