# Studio preview source

Snapshot of the green ezpz-studio-redesign frontend. Re-sync with `node scripts/sync-studio-preview.mjs [source-directory]`.

Import aliases, public asset paths, storage keys, API transport, and live-mode controls are adapted. The snapshot is locked to browser-only demo mode. The sync script reapplies this boundary and fails if the expected source structure changes. The page is rendered in its own iframe so the actual redesign components, fonts, and styles stay isolated from the landing page and legacy app. Third-party notices are retained in `licenses/studio-preview`.
