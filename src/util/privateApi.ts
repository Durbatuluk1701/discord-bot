import { Config } from './Config';
import { container } from 'tsyringe';

const config = container.resolve(Config);

function buildUrl(path: string, query?: Record<string, string | number | boolean>): string {
  const base = `${config.statsfm.http.apiUrl}/v${config.statsfm.http.version}${path}`;
  if (!query) return base;
  const params = new URLSearchParams(
    Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))
  );
  return `${base}?${params.toString()}`;
}

export async function privateApiGet<T>(
  path: string,
  query?: Record<string, string | number | boolean>
): Promise<T> {
  const url = buildUrl(path, query);
  const res = await fetch(url, {
    headers: {
      Authorization: config.privateApiToken!
    }
  });
  if (!res.ok) {
    throw new Error(`Private API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function privateApiPost<T>(
  path: string,
  body: unknown,
  query?: Record<string, string | number | boolean>
): Promise<T> {
  const url = buildUrl(path, query);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: config.privateApiToken!,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`Private API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}
