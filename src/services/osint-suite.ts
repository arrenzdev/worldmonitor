export type OsintToolId = 'velocity' | 'ironsight' | 'shadowbroker';

export interface OsintToolDefinition {
  id: OsintToolId;
  name: string;
  summary: string;
  repositoryUrl: string;
  defaultUrl: string;
  capabilities: readonly string[];
}

export type OsintSuiteUrls = Record<OsintToolId, string>;

export const OSINT_SUITE_STORAGE_KEY = 'worldmonitor-osint-suite-v1';

export const OSINT_TOOLS: readonly OsintToolDefinition[] = [
  {
    id: 'velocity',
    name: 'Velocity',
    summary: 'Historical replay, evidence provenance, investigations, graph analysis and reports.',
    repositoryUrl: 'https://github.com/AndrewCTF/velocity',
    defaultUrl: 'http://127.0.0.1:3101',
    capabilities: ['Time replay', 'Evidence locker', 'Investigation graph', 'Reports'],
  },
  {
    id: 'ironsight',
    name: 'IRONSIGHT',
    summary: 'Conflict theaters, live alerts, military tracking, markets and crisis intelligence.',
    repositoryUrl: 'https://github.com/NoblerWorks-HQ/IRONSIGHT',
    defaultUrl: 'http://127.0.0.1:3102',
    capabilities: ['Conflict theaters', 'Air-raid alerts', 'Force tracking', 'Markets'],
  },
  {
    id: 'shadowbroker',
    name: 'Shadowbroker',
    summary: 'Broad reconnaissance across transport, space, infrastructure, hazards and networks.',
    repositoryUrl: 'https://github.com/BigBodyCobain/Shadowbroker',
    defaultUrl: 'http://127.0.0.1:3103',
    capabilities: ['Recon toolkit', 'Aviation & maritime', 'Infrastructure', 'Time Machine'],
  },
] as const;

export const DEFAULT_OSINT_SUITE_URLS: Readonly<OsintSuiteUrls> = Object.freeze(
  Object.fromEntries(OSINT_TOOLS.map((tool) => [tool.id, tool.defaultUrl])) as OsintSuiteUrls,
);

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

export function normalizeOsintToolUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.username || url.password) return null;

    const isSecure = url.protocol === 'https:';
    const isLocalHttp = url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (!isSecure && !isLocalHttp) return null;

    url.hash = '';
    if (url.pathname === '/' && !url.search) return url.origin;
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return null;
  }
}

export function loadOsintSuiteUrls(storage?: StorageReader): OsintSuiteUrls {
  const defaults = { ...DEFAULT_OSINT_SUITE_URLS };
  const reader = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  if (!reader) return defaults;

  try {
    const raw = reader.getItem(OSINT_SUITE_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return defaults;

    for (const tool of OSINT_TOOLS) {
      const candidate = (parsed as Record<string, unknown>)[tool.id];
      if (typeof candidate !== 'string') continue;
      const normalized = normalizeOsintToolUrl(candidate);
      if (normalized) defaults[tool.id] = normalized;
    }
  } catch {
    // Storage can be unavailable in privacy modes. Defaults keep the panel usable.
  }
  return defaults;
}

export function saveOsintSuiteUrls(urls: OsintSuiteUrls, storage?: StorageWriter): boolean {
  const writer = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  if (!writer) return false;

  const normalized = {} as OsintSuiteUrls;
  for (const tool of OSINT_TOOLS) {
    const value = normalizeOsintToolUrl(urls[tool.id]);
    if (!value) return false;
    normalized[tool.id] = value;
  }

  try {
    writer.setItem(OSINT_SUITE_STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}
