// Fortress fork: authenticated calls to the local Fortress server's /api/fortress/* routes.
import { readDesktopPrimaryBearerToken } from "~/environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary/target";

export async function fetchFortress<A>(
  path: string,
  params?: Record<string, string>,
  init?: { readonly method?: string; readonly body?: unknown },
): Promise<A> {
  const token = await readDesktopPrimaryBearerToken();
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(resolvePrimaryEnvironmentHttpUrl(path, params), {
    method: init?.method ?? "GET",
    headers,
    credentials: token ? "omit" : "include",
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as A & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}
