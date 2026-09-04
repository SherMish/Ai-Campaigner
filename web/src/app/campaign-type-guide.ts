// The guide explains the confusing overlap between post engagement and
// messaging campaigns. It is not relevant to a website-conversion campaign.
export function shouldShowCampaignTypeGuide(destination?: string | null): boolean {
  return destination === "whatsapp" || destination === "engagement";
}

