-- AIC-102: the additions/creative flow needs a destination URL for a
-- website/Pixel campaign's new-content path (object_story_spec.link_data.link)
-- the same way whatsapp_destination serves the messaging path. Nullable —
-- unused by WhatsApp campaigns, and an existing-post creative needs neither.
ALTER TABLE managed_campaigns ADD COLUMN website_url TEXT;
