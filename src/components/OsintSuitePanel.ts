import { Panel } from './Panel';
import { openExternalUrl } from '@/services/external-navigation';
import {
  DEFAULT_OSINT_SUITE_URLS,
  applyManagedOsintSuiteUrls,
  getManagedOsintSuiteStatus,
  loadOsintSuiteUrls,
  normalizeOsintToolUrl,
  OSINT_TOOLS,
  saveOsintSuiteUrls,
  type OsintSuiteUrls,
  type ManagedOsintSuiteStatus,
  type OsintToolDefinition,
  type OsintToolId,
} from '@/services/osint-suite';

export class OsintSuitePanel extends Panel {
  private activeToolId: OsintToolId = 'velocity';
  private urls: OsintSuiteUrls = loadOsintSuiteUrls();
  private iframe: HTMLIFrameElement | null = null;
  private hasLaunched = false;
  private managedStatus: ManagedOsintSuiteStatus | null = null;

  constructor() {
    super({
      id: 'osint-suite',
      title: 'OSINT Suite',
      className: 'panel-wide osint-suite-panel',
      closable: true,
      defaultRowSpan: 4,
    });
    this.renderWorkspace();
    void this.initializeManagedDesktopRuntime();
  }

  private get activeTool(): OsintToolDefinition {
    return OSINT_TOOLS.find((tool) => tool.id === this.activeToolId) ?? OSINT_TOOLS[0]!;
  }

  private setSuiteBadge(label: string, state: 'idle' | 'loading' | 'live' | 'warning'): void {
    if (!this.statusBadgeEl) return;
    this.statusBadgeEl.textContent = label;
    this.statusBadgeEl.className = `panel-data-badge osint-suite-badge osint-suite-badge--${state}`;
    this.statusBadgeEl.style.display = 'inline-flex';
  }

  private renderWorkspace(): void {
    this.unloadIframe();
    this.content.className = 'panel-content osint-suite-content';

    const shell = document.createElement('div');
    shell.className = 'osint-suite-shell';

    const toolbar = document.createElement('div');
    toolbar.className = 'osint-suite-toolbar';

    const tabs = document.createElement('div');
    tabs.className = 'osint-suite-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'OSINT tools');

    for (const tool of OSINT_TOOLS) {
      const tab = document.createElement('button');
      const selected = tool.id === this.activeToolId;
      tab.type = 'button';
      tab.className = `osint-suite-tab${selected ? ' is-active' : ''}`;
      tab.textContent = tool.name;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(selected));
      tab.addEventListener('click', () => {
        if (this.activeToolId === tool.id) return;
        this.activeToolId = tool.id;
        const relaunch = this.hasLaunched;
        this.renderWorkspace();
        if (relaunch) void this.launchActiveTool();
      }, { signal: this.signal });
      tabs.appendChild(tab);
    }

    const actions = document.createElement('div');
    actions.className = 'osint-suite-actions';

    const reloadButton = this.createActionButton('Reload', 'Reload selected OSINT tool', () => {
      void this.launchActiveTool();
    });
    const externalButton = this.createActionButton('Open ↗', 'Open selected OSINT tool in a new window', () => {
      void openExternalUrl(this.urls[this.activeToolId]);
    });
    const settingsButton = this.createActionButton('Configure', 'Configure OSINT service URLs', () => {
      this.renderSettings();
    });
    actions.append(reloadButton, externalButton, settingsButton);
    toolbar.append(tabs, actions);

    const viewport = document.createElement('div');
    viewport.className = 'osint-suite-viewport';
    viewport.setAttribute('role', 'tabpanel');
    viewport.setAttribute('aria-label', this.activeTool.name);

    const intro = document.createElement('div');
    intro.className = 'osint-suite-intro';

    const eyebrow = document.createElement('span');
    eyebrow.className = 'osint-suite-eyebrow';
    eyebrow.textContent = 'ISOLATED LOCAL WORKSPACE';

    const heading = document.createElement('h3');
    heading.textContent = this.activeTool.name;

    const summary = document.createElement('p');
    summary.textContent = this.activeTool.summary;

    const capabilityList = document.createElement('div');
    capabilityList.className = 'osint-suite-capabilities';
    for (const capability of this.activeTool.capabilities) {
      const chip = document.createElement('span');
      chip.textContent = capability;
      capabilityList.appendChild(chip);
    }

    const urlLabel = document.createElement('code');
    urlLabel.className = 'osint-suite-url';
    urlLabel.textContent = this.urls[this.activeToolId];

    const launchButton = document.createElement('button');
    launchButton.type = 'button';
    launchButton.className = 'osint-suite-launch';
    launchButton.textContent = `Launch ${this.activeTool.name}`;
    launchButton.addEventListener('click', () => void this.launchActiveTool(), { signal: this.signal });

    const sourceButton = document.createElement('button');
    sourceButton.type = 'button';
    sourceButton.className = 'osint-suite-source';
    sourceButton.textContent = 'Upstream source ↗';
    sourceButton.addEventListener('click', () => {
      void openExternalUrl(this.activeTool.repositoryUrl);
    }, { signal: this.signal });

    const launchRow = document.createElement('div');
    launchRow.className = 'osint-suite-launch-row';
    launchRow.append(launchButton, sourceButton);

    intro.append(eyebrow, heading, summary, capabilityList, urlLabel, launchRow);
    viewport.appendChild(intro);
    shell.append(toolbar, viewport);
    this.setContentNodes(shell);
    const managed = this.managedStatus?.tools.find((tool) => tool.id === this.activeToolId);
    if (managed?.state === 'starting' || managed?.state === 'pending') {
      this.setSuiteBadge('STARTING', 'loading');
    } else if (managed?.state === 'failed' || managed?.state === 'unavailable') {
      this.setSuiteBadge('ATTENTION', 'warning');
    } else {
      this.setSuiteBadge('READY', 'idle');
    }
  }

  private createActionButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'osint-suite-action';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', onClick, { signal: this.signal });
    return button;
  }

  private async initializeManagedDesktopRuntime(): Promise<void> {
    const status = await this.refreshManagedRuntime();
    if (!status?.bundled || this.signal.aborted) return;
    this.renderWorkspace();
    void this.launchActiveTool();
  }

  private async refreshManagedRuntime(): Promise<ManagedOsintSuiteStatus | null> {
    const status = await getManagedOsintSuiteStatus();
    if (status) {
      this.managedStatus = status;
      this.urls = applyManagedOsintSuiteUrls(this.urls, status);
    }
    return status;
  }

  private async waitForManagedTool(): Promise<string | null> {
    const startedAt = Date.now();
    while (!this.signal.aborted && Date.now() - startedAt < 150_000) {
      const status = await this.refreshManagedRuntime();
      const tool = status?.tools.find((candidate) => candidate.id === this.activeToolId);
      if (!tool || !status?.bundled) return this.urls[this.activeToolId];
      if (tool.state === 'ready' && tool.url) return this.urls[this.activeToolId];
      if (tool.state === 'failed' || tool.state === 'unavailable' || tool.state === 'stopped') {
        return null;
      }
      this.setSuiteBadge('STARTING', 'loading');
      await new Promise((resolve) => window.setTimeout(resolve, 750));
    }
    return null;
  }

  private async launchActiveTool(): Promise<void> {
    const viewport = this.content.querySelector<HTMLElement>('.osint-suite-viewport');
    if (!viewport) return;

    const target = await this.waitForManagedTool();
    if (!target || this.signal.aborted) {
      const tool = this.managedStatus?.tools.find((candidate) => candidate.id === this.activeToolId);
      this.hasLaunched = false;
      this.setSuiteBadge('UNAVAILABLE', 'warning');
      this.renderEmbedWarning(
        viewport,
        tool?.message ?? 'The managed service did not become ready. Check the OSINT logs from World Monitor settings.',
      );
      return;
    }
    const parsed = new URL(target);
    if (window.location.protocol === 'https:' && parsed.protocol === 'http:') {
      this.hasLaunched = false;
      this.setSuiteBadge('OPEN EXTERNALLY', 'warning');
      this.renderEmbedWarning(
        viewport,
        'The local service uses HTTP and cannot be embedded in an HTTPS page. Run the self-hosted stack over HTTP or open the tool externally.',
      );
      return;
    }

    this.unloadIframe();
    viewport.replaceChildren();
    const frame = document.createElement('iframe');
    frame.className = 'osint-suite-frame';
    frame.title = `${this.activeTool.name} workspace`;
    frame.src = target;
    frame.referrerPolicy = 'no-referrer';
    frame.loading = 'eager';
    frame.allowFullscreen = true;
    frame.allow = 'autoplay; clipboard-read; clipboard-write; fullscreen; geolocation';
    frame.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads',
    );
    frame.addEventListener('load', () => this.setSuiteBadge(this.activeTool.name.toUpperCase(), 'live'), {
      once: true,
      signal: this.signal,
    });
    viewport.appendChild(frame);
    this.iframe = frame;
    this.hasLaunched = true;
    this.setSuiteBadge('LOADING', 'loading');
  }

  private renderEmbedWarning(viewport: HTMLElement, message: string): void {
    const warning = document.createElement('div');
    warning.className = 'osint-suite-warning';
    const text = document.createElement('p');
    text.textContent = message;
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'osint-suite-launch';
    openButton.textContent = `Open ${this.activeTool.name} externally`;
    openButton.addEventListener('click', () => {
      void openExternalUrl(this.urls[this.activeToolId]);
    }, { signal: this.signal });
    warning.append(text, openButton);
    viewport.replaceChildren(warning);
  }

  private renderSettings(): void {
    this.unloadIframe();
    this.hasLaunched = false;
    this.content.className = 'panel-content osint-suite-content';

    const form = document.createElement('form');
    form.className = 'osint-suite-settings';

    const heading = document.createElement('h3');
    heading.textContent = 'OSINT Suite endpoints';
    const help = document.createElement('p');
    help.textContent = 'HTTPS endpoints are accepted anywhere. Plain HTTP is restricted to localhost for safety.';
    form.append(heading, help);

    const inputs = new Map<OsintToolId, HTMLInputElement>();
    for (const tool of OSINT_TOOLS) {
      const field = document.createElement('label');
      field.className = 'osint-suite-field';
      const label = document.createElement('span');
      label.textContent = tool.name;
      const input = document.createElement('input');
      input.type = 'url';
      input.required = true;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.value = this.urls[tool.id];
      input.placeholder = tool.defaultUrl;
      field.append(label, input);
      form.appendChild(field);
      inputs.set(tool.id, input);
    }

    const error = document.createElement('p');
    error.className = 'osint-suite-settings-error';
    error.setAttribute('role', 'alert');

    const actions = document.createElement('div');
    actions.className = 'osint-suite-settings-actions';
    const saveButton = document.createElement('button');
    saveButton.type = 'submit';
    saveButton.className = 'osint-suite-launch';
    saveButton.textContent = 'Save endpoints';
    const resetButton = this.createActionButton('Reset defaults', 'Restore local OSINT Suite endpoints', () => {
      for (const tool of OSINT_TOOLS) inputs.get(tool.id)!.value = DEFAULT_OSINT_SUITE_URLS[tool.id];
      error.textContent = '';
    });
    const cancelButton = this.createActionButton('Cancel', 'Return to OSINT Suite', () => this.renderWorkspace());
    actions.append(saveButton, resetButton, cancelButton);
    form.append(error, actions);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const next = {} as OsintSuiteUrls;
      for (const tool of OSINT_TOOLS) {
        const normalized = normalizeOsintToolUrl(inputs.get(tool.id)!.value);
        if (!normalized) {
          error.textContent = `${tool.name}: use HTTPS, or HTTP on localhost / 127.0.0.1.`;
          inputs.get(tool.id)!.focus();
          return;
        }
        next[tool.id] = normalized;
      }
      if (!saveOsintSuiteUrls(next)) {
        error.textContent = 'The browser could not save these settings. Check site storage permissions.';
        return;
      }
      this.urls = next;
      this.renderWorkspace();
    }, { signal: this.signal });

    this.setContentNodes(form);
    this.setSuiteBadge('CONFIGURE', 'idle');
  }

  private unloadIframe(): void {
    if (!this.iframe) return;
    this.iframe.src = 'about:blank';
    this.iframe.remove();
    this.iframe = null;
  }

  public destroy(): void {
    this.unloadIframe();
    super.destroy();
  }
}
