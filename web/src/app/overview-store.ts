import { useSyncExternalStore } from "react";
import { getOverview, setApiCampaign, type CustomerOverview } from "../api";

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
// AIC-194 — which load is the CURRENT one.
//
// The bug this fixes: switching campaigns orphaned the in-flight request but
// could not cancel it, so its `.then` still fired and wrote the OLD campaign's
// numbers into state. Whichever request finished LAST won, which on a slow
// Meta-backed overview is often the one the customer already navigated away
// from — the dashboard silently showed the previous campaign's spend and leads
// under the new campaign's name.
//
// A monotonic token rather than AbortController: the stale response is not an
// error to swallow, it is simply no longer the answer to the current question,
// and ignoring it is the whole requirement.
let generation = 0;
const subscribers = new Set<() => void>();

function setState(next: Partial<State>) {
  state = { ...state, ...next };
  for (const fn of subscribers) fn();
}

function load(): Promise<void> {
  if (inflight) return inflight;
  const gen = ++generation;
  setState({ loading: true, error: false });
  inflight = getOverview(selectedCampaignId)
    .then((data) => { if (gen === generation) setState({ data, loading: false, error: false }); })
    .catch(() => { if (gen === generation) setState({ loading: false, error: true }); })
    // Only the CURRENT load may clear the slot. A stale one finishing later
    // would otherwise blank `inflight` while a newer request is still running,
    // letting a third load start on top of it.
    .finally(() => { if (gen === generation) inflight = null; });
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
  // Every subsequent /app request carries it — not just the overview. Without
  // this the dashboard switches and add-content keeps writing to the old one.
  setApiCampaign(campaignId);
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
