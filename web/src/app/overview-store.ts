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
// AIC-186 — which campaign this shared overview is showing. The store is
// shared with the sidebar and settings, so the selection has to live HERE:
// two components fetching different campaigns into one cache is how a
// customer ends up reading one campaign's numbers under another's name.
let selectedCampaignId: string | null = null;
const subscribers = new Set<() => void>();

function setState(next: Partial<State>) {
  state = { ...state, ...next };
  for (const fn of subscribers) fn();
}

function load(): Promise<void> {
  if (inflight) return inflight;
  setState({ loading: true, error: false });
  inflight = getOverview(selectedCampaignId)
    .then((data) => setState({ data, loading: false, error: false }))
    .catch(() => setState({ loading: false, error: true }))
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * Switch the whole shell to another of the customer's campaigns.
 *
 * Clears `data` before refetching rather than leaving the previous campaign's
 * numbers on screen under the new campaign's name — a stale headline during a
 * switch is exactly the kind of thing that gets read as fact.
 */
export function selectCampaign(campaignId: string | null): void {
  if (selectedCampaignId === campaignId) return;
  selectedCampaignId = campaignId;
  inflight = null;
  setState({ data: null, loading: true, error: false });
  load();
}

export function selectedCampaign(): string | null {
  return selectedCampaignId;
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
