use std::collections::{BTreeMap, HashMap};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::net::{TcpListener, TcpStream};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const TOOL_IDS: [&str; 3] = ["velocity", "ironsight", "shadowbroker"];
const STARTUP_TIMEOUT: Duration = Duration::from_secs(150);
const VELOCITY_SECRET_KEYS: [&str; 9] = [
    "CLOUDFLARE_API_TOKEN",
    "ACLED_ACCESS_TOKEN",
    "OPENSKY_CLIENT_ID",
    "OPENSKY_CLIENT_SECRET",
    "AISSTREAM_API_KEY",
    "NASA_FIRMS_API_KEY",
    "OLLAMA_API_URL",
    "OLLAMA_MODEL",
    "FINNHUB_API_KEY",
];
const SHADOWBROKER_SECRET_KEYS: [&str; 4] = [
    "OPENSKY_CLIENT_ID",
    "OPENSKY_CLIENT_SECRET",
    "AISSTREAM_API_KEY",
    "FINNHUB_API_KEY",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsintToolRuntimeStatus {
    id: String,
    state: String,
    url: Option<String>,
    message: Option<String>,
}

impl OsintToolRuntimeStatus {
    fn new(id: &str, state: &str, message: Option<String>) -> Self {
        Self {
            id: id.to_string(),
            state: state.to_string(),
            url: None,
            message,
        }
    }
}

struct ManagedTool {
    status: OsintToolRuntimeStatus,
    children: Vec<Child>,
}

impl ManagedTool {
    fn pending(id: &str) -> Self {
        Self {
            status: OsintToolRuntimeStatus::new(id, "pending", None),
            children: Vec::new(),
        }
    }
}

struct OsintSuiteInner {
    tools: Mutex<BTreeMap<String, ManagedTool>>,
    started: AtomicBool,
    stopping: AtomicBool,
}

#[derive(Clone)]
pub struct OsintSuiteState {
    inner: Arc<OsintSuiteInner>,
}

impl Default for OsintSuiteState {
    fn default() -> Self {
        let tools = TOOL_IDS
            .into_iter()
            .map(|id| (id.to_string(), ManagedTool::pending(id)))
            .collect();
        Self {
            inner: Arc::new(OsintSuiteInner {
                tools: Mutex::new(tools),
                started: AtomicBool::new(false),
                stopping: AtomicBool::new(false),
            }),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsintSuiteRuntimeStatus {
    bundled: bool,
    platform: String,
    tools: Vec<OsintToolRuntimeStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    schema: String,
    bundle_version: String,
    platform: String,
    checksums: HashMap<String, String>,
}

#[derive(Deserialize, Serialize)]
struct ManagedSecrets {
    admin_key: String,
    mesh_peer_push_secret: String,
    mesh_dm_token_pepper: String,
}

struct RuntimeContext {
    runtime_root: PathBuf,
    data_root: PathBuf,
    logs_root: PathBuf,
    node_binary: PathBuf,
    python_binary: PathBuf,
    python_site_packages: PathBuf,
    manifest: RuntimeManifest,
    cached_secrets: HashMap<String, String>,
    managed_secrets: ManagedSecrets,
}

fn set_status(inner: &Arc<OsintSuiteInner>, status: OsintToolRuntimeStatus) {
    if let Ok(mut tools) = inner.tools.lock() {
        let children = tools
            .remove(&status.id)
            .map(|tool| tool.children)
            .unwrap_or_default();
        tools.insert(status.id.clone(), ManagedTool { status, children });
    }
}

fn set_ready(
    inner: &Arc<OsintSuiteInner>,
    id: &str,
    url: String,
    children: Vec<Child>,
) {
    if inner.stopping.load(Ordering::SeqCst) {
        for mut child in children {
            stop_child_tree(&mut child);
        }
        return;
    }
    if let Ok(mut tools) = inner.tools.lock() {
        tools.insert(
            id.to_string(),
            ManagedTool {
                status: OsintToolRuntimeStatus {
                    id: id.to_string(),
                    state: "ready".to_string(),
                    url: Some(url),
                    message: None,
                },
                children,
            },
        );
    }
}

fn runtime_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(explicit) = env::var("WM_OSINT_SUITE_RUNTIME_DIR") {
        candidates.push(PathBuf::from(explicit));
    }
    if cfg!(debug_assertions) {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("osint-suite")
                .join("runtime"),
        );
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("osint-suite").join("runtime"));
        candidates.push(
            resource_dir
                .join("_up_")
                .join("src-tauri")
                .join("osint-suite")
                .join("runtime"),
        );
    }
    candidates
}

fn read_runtime_manifest(root: &Path) -> Result<RuntimeManifest, String> {
    let path = root.join("runtime-manifest.json");
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("managed runtime manifest missing at {}: {e}", path.display()))?;
    let manifest: RuntimeManifest = serde_json::from_str(&raw)
        .map_err(|e| format!("managed runtime manifest is invalid: {e}"))?;
    if manifest.schema != "worldmonitor-osint-suite-bundle/v1" {
        return Err(format!("unsupported managed runtime schema: {}", manifest.schema));
    }
    if manifest.platform != "windows-x64" {
        return Err(format!("managed runtime targets {}, not windows-x64", manifest.platform));
    }
    let required = [
        "python/python.exe",
        "velocity/apps/api/app/main.py",
        "velocity/apps/web/dist/index.html",
        "velocity/tools/adsb-globe-feeder/node_modules/playwright/package.json",
        "ironsight/server.js",
        "shadowbroker/backend/main.py",
        "shadowbroker/backend/privacy_core.dll",
        "shadowbroker/web/index.html",
    ];
    for relative in required {
        if !manifest.checksums.contains_key(relative) || !root.join(relative).is_file() {
            return Err(format!("managed runtime is incomplete: {relative}"));
        }
    }
    Ok(manifest)
}

fn resolve_runtime_root(app: &AppHandle) -> Result<(PathBuf, RuntimeManifest), String> {
    for candidate in runtime_candidates(app) {
        if let Ok(manifest) = read_runtime_manifest(&candidate) {
            return Ok((candidate, manifest));
        }
    }
    Err("This desktop package does not contain the managed Windows OSINT runtime".to_string())
}

fn load_or_create_managed_secrets(data_root: &Path) -> Result<ManagedSecrets, String> {
    let path = data_root.join("managed-secrets.json");
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(secrets) = serde_json::from_str::<ManagedSecrets>(&raw) {
            if secrets.admin_key.len() >= 32
                && secrets.mesh_peer_push_secret.len() >= 16
                && secrets.mesh_dm_token_pepper.len() >= 16
            {
                return Ok(secrets);
            }
        }
    }
    fs::create_dir_all(data_root)
        .map_err(|e| format!("managed OSINT data directory could not be created: {e}"))?;
    let secrets = ManagedSecrets {
        admin_key: crate::generate_local_token(),
        mesh_peer_push_secret: crate::generate_local_token(),
        mesh_dm_token_pepper: crate::generate_local_token(),
    };
    let serialized = serde_json::to_string_pretty(&secrets)
        .map_err(|e| format!("managed secrets could not be serialized: {e}"))?;
    fs::write(&path, format!("{serialized}\n"))
        .map_err(|e| format!("managed secrets could not be persisted: {e}"))?;
    Ok(secrets)
}

fn build_runtime_context(app: &AppHandle) -> Result<RuntimeContext, String> {
    let (runtime_root, manifest) = resolve_runtime_root(app)?;
    let data_root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("managed OSINT app data directory unavailable: {e}"))?
        .join("osint-suite");
    let logs_root = crate::logs_dir_path(app)?.join("osint-suite");
    fs::create_dir_all(&logs_root)
        .map_err(|e| format!("managed OSINT logs directory could not be created: {e}"))?;
    fs::create_dir_all(&data_root)
        .map_err(|e| format!("managed OSINT data directory could not be created: {e}"))?;
    let node_binary = crate::resolve_node_binary(app)
        .ok_or_else(|| "World Monitor's bundled Node runtime is unavailable".to_string())?;
    let python_binary = runtime_root.join("python").join("python.exe");
    let python_site_packages = runtime_root
        .join("python")
        .join("Lib")
        .join("site-packages");
    let cached_secrets = app
        .state::<crate::SecretsCache>()
        .secrets
        .lock()
        .map(|values| {
            values
                .iter()
                .filter(|(key, value)| {
                    (VELOCITY_SECRET_KEYS.contains(&key.as_str())
                        || SHADOWBROKER_SECRET_KEYS.contains(&key.as_str()))
                        && !value.trim().is_empty()
                })
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default();
    let managed_secrets = load_or_create_managed_secrets(&data_root)?;
    Ok(RuntimeContext {
        runtime_root,
        data_root,
        logs_root,
        node_binary,
        python_binary,
        python_site_packages,
        manifest,
        cached_secrets,
        managed_secrets,
    })
}

fn reserve_loopback_port() -> Result<u16, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|e| format!("no loopback port is available: {e}"))
}

fn wait_for_port(child: &mut Child, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("process exited before readiness: {status}"));
        }
        if TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}")
                .parse()
                .map_err(|e| format!("invalid loopback address: {e}"))?,
            Duration::from_millis(300),
        )
        .is_ok()
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!("process did not bind port {port} within the startup timeout"))
}

fn log_files(logs_root: &Path, name: &str) -> Result<(File, File), String> {
    let path = logs_root.join(format!("{name}.log"));
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    let stderr = stdout
        .try_clone()
        .map_err(|e| format!("could not clone {}: {e}", path.display()))?;
    Ok((stdout, stderr))
}

fn hide_console(_command: &mut Command) {
    #[cfg(windows)]
    _command.creation_flags(0x08000000);
}

fn prepend_runtime_path(command: &mut Command, context: &RuntimeContext) {
    let mut entries = vec![
        context
            .node_binary
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf(),
        context.runtime_root.join("python"),
        context.runtime_root.join("python").join("Scripts"),
    ];
    if let Some(existing) = env::var_os("PATH") {
        entries.extend(env::split_paths(&existing));
    }
    if let Ok(path) = env::join_paths(entries) {
        command.env("PATH", path);
    }
}

fn inject_cached_secrets(
    command: &mut Command,
    values: &HashMap<String, String>,
    allowed_keys: &[&str],
) {
    for (key, value) in values {
        if allowed_keys.contains(&key.as_str()) && !value.trim().is_empty() {
            command.env(key, value);
        }
    }
}

fn set_alias(command: &mut Command, values: &HashMap<String, String>, target: &str, source: &str) {
    if let Some(value) = values.get(source).filter(|value| !value.trim().is_empty()) {
        command.env(target, value);
    }
}

fn python_path(context: &RuntimeContext, source_root: &Path) -> Result<std::ffi::OsString, String> {
    env::join_paths([source_root, context.python_site_packages.as_path()])
        .map_err(|e| format!("managed Python path could not be constructed: {e}"))
}

fn find_file_named(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && entry.file_name().to_string_lossy().eq_ignore_ascii_case(name) {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_file_named(&path, name) {
                return Some(found);
            }
        }
    }
    None
}

fn configure_playwright(command: &mut Command, context: &RuntimeContext) -> Option<PathBuf> {
    let browser_root = context.runtime_root.join("python").join("playwright-browsers");
    command.env("PLAYWRIGHT_BROWSERS_PATH", &browser_root);
    let chrome = find_file_named(&browser_root, "chrome.exe");
    if let Some(path) = &chrome {
        command.env("CHROME_PATH", path);
    }
    chrome
}

fn start_velocity(context: &RuntimeContext) -> Result<(String, Vec<Child>), String> {
    let port = reserve_loopback_port()?;
    let work_dir = context.data_root.join("velocity");
    fs::create_dir_all(work_dir.join("data"))
        .map_err(|e| format!("Velocity data directory could not be created: {e}"))?;
    let velocity_root = context.runtime_root.join("velocity");
    let api_root = velocity_root.join("apps").join("api");
    let web_root = velocity_root.join("apps").join("web").join("dist");
    let (stdout, stderr) = log_files(&context.logs_root, "velocity")?;
    let mut command = Command::new(&context.python_binary);
    command
        .current_dir(&work_dir)
        .args([
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--workers",
            "1",
        ])
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONPATH", python_path(context, &api_root)?)
        .env("OSINT_WEB_DIST", &web_root)
        .env(
            "FUSION_DIR",
            velocity_root.join("apps").join("ml").join("fusion"),
        )
        .env(
            "NODE_PATH",
            velocity_root
                .join("tools")
                .join("adsb-globe-feeder")
                .join("node_modules"),
        )
        .env("ARCHIVE_MODE", "1")
        .env("HISTORY_DISK_BUDGET_GB", "5")
        .env("ALLOW_UNAUTHENTICATED", "1")
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    inject_cached_secrets(
        &mut command,
        &context.cached_secrets,
        &VELOCITY_SECRET_KEYS,
    );
    set_alias(&mut command, &context.cached_secrets, "AISSTREAM_KEY", "AISSTREAM_API_KEY");
    set_alias(&mut command, &context.cached_secrets, "FIRMS_MAP_KEY", "NASA_FIRMS_API_KEY");
    set_alias(&mut command, &context.cached_secrets, "GFW_TOKEN", "GFW_API_TOKEN");
    set_alias(&mut command, &context.cached_secrets, "ACLED_KEY", "ACLED_ACCESS_TOKEN");
    set_alias(
        &mut command,
        &context.cached_secrets,
        "CLOUDFLARE_TOKEN",
        "CLOUDFLARE_API_TOKEN",
    );
    set_alias(
        &mut command,
        &context.cached_secrets,
        "OLLAMA_HOST",
        "OLLAMA_API_URL",
    );
    if configure_playwright(&mut command, context).is_none() {
        return Err("Bundled Chromium is unavailable for Velocity's browser feeds".to_string());
    }
    prepend_runtime_path(&mut command, context);
    hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Velocity could not be started: {e}"))?;
    if let Err(error) = wait_for_port(&mut child, port) {
        stop_child_tree(&mut child);
        return Err(error);
    }
    Ok((format!("http://127.0.0.1:{port}"), vec![child]))
}

fn start_ironsight(context: &RuntimeContext) -> Result<(String, Vec<Child>), String> {
    let port = reserve_loopback_port()?;
    let root = context.runtime_root.join("ironsight");
    let (stdout, stderr) = log_files(&context.logs_root, "ironsight")?;
    let mut command = Command::new(&context.node_binary);
    command
        .current_dir(&root)
        .arg(root.join("server.js"))
        .env("NODE_ENV", "production")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", port.to_string())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    prepend_runtime_path(&mut command, context);
    hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("IRONSIGHT could not be started: {e}"))?;
    if let Err(error) = wait_for_port(&mut child, port) {
        stop_child_tree(&mut child);
        return Err(error);
    }
    Ok((format!("http://127.0.0.1:{port}"), vec![child]))
}

fn copy_runtime_tree(source: &Path, destination: &Path, preserve_existing: bool) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|e| format!("could not create {}: {e}", destination.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|e| format!("could not read {}: {e}", source.display()))?
    {
        let entry = entry.map_err(|e| format!("runtime directory entry failed: {e}"))?;
        let name = entry.file_name();
        if name.to_string_lossy() == ".env" {
            continue;
        }
        let from = entry.path();
        let to = destination.join(&name);
        let is_data = name.to_string_lossy() == "data";
        if entry
            .file_type()
            .map_err(|e| format!("runtime file type failed: {e}"))?
            .is_dir()
        {
            copy_runtime_tree(&from, &to, preserve_existing || is_data)?;
        } else if !preserve_existing || !to.exists() {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
            }
            fs::copy(&from, &to).map_err(|e| {
                format!("could not copy {} to {}: {e}", from.display(), to.display())
            })?;
        }
    }
    Ok(())
}

fn install_shadowbroker_backend(context: &RuntimeContext) -> Result<PathBuf, String> {
    let source = context
        .runtime_root
        .join("shadowbroker")
        .join("backend");
    let destination = context
        .data_root
        .join("shadowbroker")
        .join("managed-backend");
    let marker = destination.join(".worldmonitor-bundle-version");
    let installed = fs::read_to_string(&marker).ok();
    if installed.as_deref().map(str::trim) != Some(context.manifest.bundle_version.as_str())
        || !destination.join("main.py").is_file()
    {
        copy_runtime_tree(&source, &destination, false)?;
        fs::write(&marker, format!("{}\n", context.manifest.bundle_version))
            .map_err(|e| format!("Shadowbroker runtime marker could not be written: {e}"))?;
    }
    fs::create_dir_all(destination.join("data"))
        .map_err(|e| format!("Shadowbroker data directory could not be created: {e}"))?;
    Ok(destination)
}

fn start_shadowbroker(context: &RuntimeContext) -> Result<(String, Vec<Child>), String> {
    let backend_port = reserve_loopback_port()?;
    let host_port = reserve_loopback_port()?;
    let backend_root = install_shadowbroker_backend(context)?;
    let (backend_stdout, backend_stderr) = log_files(&context.logs_root, "shadowbroker-backend")?;
    let mut backend = Command::new(&context.python_binary);
    backend
        .current_dir(&backend_root)
        .args([
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "127.0.0.1",
            "--port",
            &backend_port.to_string(),
            "--timeout-keep-alive",
            "120",
        ])
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONPATH", python_path(context, &backend_root)?)
        .env("SB_DATA_DIR", backend_root.join("data"))
        .env("PRIVACY_CORE_LIB", backend_root.join("privacy_core.dll"))
        .env("ADMIN_KEY", &context.managed_secrets.admin_key)
        .env(
            "MESH_PEER_PUSH_SECRET",
            &context.managed_secrets.mesh_peer_push_secret,
        )
        .env(
            "MESH_DM_TOKEN_PEPPER",
            &context.managed_secrets.mesh_dm_token_pepper,
        )
        .env("MESH_BLOCK_LEGACY_NODE_ID_COMPAT", "true")
        .env("MESH_BLOCK_LEGACY_AGENT_ID_LOOKUP", "true")
        .stdout(Stdio::from(backend_stdout))
        .stderr(Stdio::from(backend_stderr));
    inject_cached_secrets(
        &mut backend,
        &context.cached_secrets,
        &SHADOWBROKER_SECRET_KEYS,
    );
    set_alias(&mut backend, &context.cached_secrets, "AIS_API_KEY", "AISSTREAM_API_KEY");
    configure_playwright(&mut backend, context);
    prepend_runtime_path(&mut backend, context);
    hide_console(&mut backend);
    let mut backend_child = backend
        .spawn()
        .map_err(|e| format!("Shadowbroker backend could not be started: {e}"))?;
    if let Err(error) = wait_for_port(&mut backend_child, backend_port) {
        stop_child_tree(&mut backend_child);
        return Err(error);
    }

    let (host_stdout, host_stderr) = log_files(&context.logs_root, "shadowbroker-host")?;
    let host_script = context
        .runtime_root
        .parent()
        .unwrap_or(&context.runtime_root)
        .join("managed-host.mjs");
    let mut host = Command::new(&context.node_binary);
    host.arg(&host_script)
        .env(
            "OSINT_STATIC_ROOT",
            context.runtime_root.join("shadowbroker").join("web"),
        )
        .env(
            "OSINT_BACKEND_URL",
            format!("http://127.0.0.1:{backend_port}"),
        )
        .env("OSINT_HOST_PORT", host_port.to_string())
        .env("OSINT_ADMIN_KEY", &context.managed_secrets.admin_key)
        .stdout(Stdio::from(host_stdout))
        .stderr(Stdio::from(host_stderr));
    prepend_runtime_path(&mut host, context);
    hide_console(&mut host);
    let mut host_child = match host.spawn() {
        Ok(child) => child,
        Err(error) => {
            stop_child_tree(&mut backend_child);
            return Err(format!("Shadowbroker local host could not be started: {error}"));
        }
    };
    if let Err(error) = wait_for_port(&mut host_child, host_port) {
        stop_child_tree(&mut host_child);
        stop_child_tree(&mut backend_child);
        return Err(error);
    }
    Ok((
        format!("http://127.0.0.1:{host_port}"),
        vec![host_child, backend_child],
    ))
}

fn stop_child_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn start_tool_thread(
    id: &'static str,
    context: Arc<RuntimeContext>,
    inner: Arc<OsintSuiteInner>,
) {
    set_status(
        &inner,
        OsintToolRuntimeStatus::new(id, "starting", Some("Starting managed service".to_string())),
    );
    std::thread::spawn(move || {
        let result = match id {
            "velocity" => start_velocity(&context),
            "ironsight" => start_ironsight(&context),
            "shadowbroker" => start_shadowbroker(&context),
            _ => Err("unknown managed OSINT tool".to_string()),
        };
        match result {
            Ok((url, children)) => set_ready(&inner, id, url, children),
            Err(error) => set_status(
                &inner,
                OsintToolRuntimeStatus::new(id, "failed", Some(error)),
            ),
        }
    });
}

pub fn start_managed_osint_suite(app: &AppHandle) {
    let state = app.state::<OsintSuiteState>();
    if state.inner.started.swap(true, Ordering::SeqCst) {
        return;
    }
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        for id in TOOL_IDS {
            set_status(
                &state.inner,
                OsintToolRuntimeStatus::new(
                    id,
                    "unavailable",
                    Some("Managed OSINT services are bundled in the Windows x64 installer".to_string()),
                ),
            );
        }
        return;
    }

    let context = match build_runtime_context(app) {
        Ok(context) => Arc::new(context),
        Err(error) => {
            for id in TOOL_IDS {
                set_status(
                    &state.inner,
                    OsintToolRuntimeStatus::new(id, "unavailable", Some(error.clone())),
                );
            }
            return;
        }
    };
    for id in TOOL_IDS {
        start_tool_thread(id, Arc::clone(&context), Arc::clone(&state.inner));
    }
}

pub fn stop_managed_osint_suite(app: &AppHandle) {
    let Some(state) = app.try_state::<OsintSuiteState>() else {
        return;
    };
    state.inner.stopping.store(true, Ordering::SeqCst);
    if let Ok(mut tools) = state.inner.tools.lock() {
        for tool in tools.values_mut() {
            for child in &mut tool.children {
                stop_child_tree(child);
            }
            tool.children.clear();
            tool.status.state = "stopped".to_string();
            tool.status.url = None;
        }
    };
}

#[tauri::command]
pub fn get_osint_suite_runtime_status(
    state: tauri::State<'_, OsintSuiteState>,
) -> OsintSuiteRuntimeStatus {
    let tools: Vec<OsintToolRuntimeStatus> = state
        .inner
        .tools
        .lock()
        .map(|tools| tools.values().map(|tool| tool.status.clone()).collect())
        .unwrap_or_default();
    let bundled = tools
        .iter()
        .any(|tool: &OsintToolRuntimeStatus| matches!(tool.state.as_str(), "starting" | "ready" | "failed"));
    OsintSuiteRuntimeStatus {
        bundled,
        platform: format!("{}-{}", env::consts::OS, env::consts::ARCH),
        tools,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_manifest_without_every_critical_asset() {
        let root = env::temp_dir().join(format!("wm-osint-manifest-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("runtime-manifest.json"),
            r#"{"schema":"worldmonitor-osint-suite-bundle/v1","bundleVersion":"1","platform":"windows-x64","checksums":{}}"#,
        )
        .unwrap();
        let error = read_runtime_manifest(&root).unwrap_err();
        assert!(error.contains("incomplete"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reserves_only_a_loopback_port() {
        let port = reserve_loopback_port().unwrap();
        assert!(port > 0);
    }

    #[test]
    fn never_forwards_world_monitor_internal_secrets() {
        for secret in ["WM_DESKTOP_SHARED_SECRET", "WORLDMONITOR_API_KEY"] {
            assert!(!VELOCITY_SECRET_KEYS.contains(&secret));
            assert!(!SHADOWBROKER_SECRET_KEYS.contains(&secret));
        }
    }
}
