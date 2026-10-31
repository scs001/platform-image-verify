// React binding for the list cache (openspec: polish-web-surfaces, capability
// web-list-surfaces). Seeds from the cache so a revisited surface paints
// instantly, revalidates in the background, and re-fetches when its key is
// invalidated or the window regains focus. The pure core (lib/listCache.ts)
// owns storage and subscriptions; this hook owns the React lifecycle.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  listCacheGet,
  listCacheSet,
  listCacheSubscribe,
  type CacheStatus,
} from "../lib/listCache";

export interface ListCacheResult<T> {
  /** Last-known-good payload (from cache or the latest fetch); null before any. */
  data: T | null;
  /** "loading" only until the FIRST payload for this key; "loaded" once cached. */
  status: CacheStatus;
  /** Message from the most recent failed fetch (the surface may ignore it). */
  error: string | null;
  /** Force a re-fetch now. */
  refresh: () => Promise<void>;
}

export function useListCache<T>(key: string, fetcher: () => Promise<T>): ListCacheResult<T> {
  // Keep the latest fetcher without re-triggering effects on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [data, setData] = useState<T | null>(() => listCacheGet<T>(key) ?? null);
  const [status, setStatus] = useState<CacheStatus>(() =>
    listCacheGet(key) !== undefined ? "loaded" : "loading",
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetcherRef.current();
      listCacheSet(key, next);
      setData(next);
      setStatus("loaded");
      setError(null);
    } catch (e) {
      // A background revalidation failure must not blank a surface that already
      // has cached content — keep "loaded" and surface the message only.
      setStatus(listCacheGet(key) !== undefined ? "loaded" : "error");
      setError((e as Error).message);
    }
  }, [key]);

  // Seed from cache and fetch on mount / key change.
  useEffect(() => {
    const cached = listCacheGet<T>(key);
    setData(cached ?? null);
    setStatus(cached !== undefined ? "loaded" : "loading");
    setError(null);
    void load();
  }, [key, load]);

  // Revalidate when the window regains focus.
  useEffect(() => {
    const onFocus = () => {
      void load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  // Revalidate when this key is invalidated anywhere in the app.
  useEffect(
    () =>
      listCacheSubscribe(key, () => {
        void load();
      }),
    [key, load],
  );

  return { data, status, error, refresh: load };
}
