// One ad as Meta reports it, for the per-ad cache (see migration 041 and
// ad-state.ts for why this cache exists at all).
export interface RawAdMetaRow {
  adId: string;
  adSetId: string;
  name: string | null;
  effectiveStatus: string;
  createdTime: string | null;
}
