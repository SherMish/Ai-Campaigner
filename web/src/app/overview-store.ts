import { useSyncExternalStore } from "react";
import { getOverview, type CustomerOverview } from "../api";

// A single shared fetch of GET /api/app/overview, deduped across the shell
// (AIC-42): the sidebar needs the name + rec badge, Home needs the full
// overview, Settings needs the same shape again — without this they each fired
// their own request on every navigation. One in-flight fetch, one cache,
// subscriber-based re-render via useSyncExternalStore.
interface State {
  data: CustomerOverview | null;
  loading: boolean;
  error: boolean;
}

let state: State = { data: null, loading: true, error: false };
let inflight: Promise<void> | null = null;
const subscribers = new Set<() => void>();

function setState(next: Partial<State>) {
  state = { ...state, ...next };
  for (const fn of subscribers) fn();
}

function load(): Promise<void> {
  if (inflight) return inflight;
  setState({ loading: true, error: false });
  inflight = getOverview()
    .then((data) => setState({ data, loading: false, error: false }))
    .catch(() => setState({ loading: false, error: true }))
    .finally(() => { inflight = null; });
  return inflight;
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  if (!state.data && !inflight) load();
  return () => subscribers.delete(cb);
}

function getSnapshot(): State {
  return state;
}

// Call after an action that changes overview-visible state (e.g. approving a
// recommendation elsewhere) to force the next render to refetch.
export function invalidateOverview(): void {
  state = { ...state, data: null };
  load();
}

export function useSharedOverview(): State & { reload: () => void } {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  return { ...s, reload: load };
}
