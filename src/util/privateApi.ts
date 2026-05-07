import { Config } from './Config';
import { container } from 'tsyringe';

const DEFAULT_TIMEOUT_MS = 30_000;

function getConfig(): Config {
  return container.resolve(Config);
}

function getPrivateApiToken(): string {
  const config = getConfig();
  if (!config.privateApiToken) throw new Error('Private API token is not configured');
  return config.privateApiToken;
}

function buildUrl(path: string, query?: Record<string, string | number | boolean>): string {
  const config = getConfig();
  const base = `${config.statsfm.http.apiUrl}/v${config.statsfm.http.version}${path}`;
  if (!query) return base;
  const params = new URLSearchParams(
    Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))
  );
  return `${base}?${params.toString()}`;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const error = err as { name?: string; message?: string };
    if (error?.name === 'AbortError') {
      throw new Error(`Private API request timed out after ${DEFAULT_TIMEOUT_MS}ms: ${url}`);
    }
    throw new Error(`Private API request failed: ${url} - ${error?.message ?? String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function privateApiGet<T>(
  path: string,
  query?: Record<string, string | number | boolean>
): Promise<T> {
  const url = buildUrl(path, query);
  const res = await fetchWithTimeout(url, {
    headers: {
      Authorization: getPrivateApiToken(),
      Accept: 'application/json'
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Private API error: GET ${url} - ${res.status} ${res.statusText} - ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function privateApiPost<T>(
  path: string,
  body: unknown,
  query?: Record<string, string | number | boolean>
): Promise<T> {
  const url = buildUrl(path, query);
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: getPrivateApiToken(),
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const responseBody = await res.text();
    throw new Error(
      `Private API error: POST ${url} - ${res.status} ${res.statusText} - ${responseBody}`
    );
  }
  return res.json() as Promise<T>;
}
