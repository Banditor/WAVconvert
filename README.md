# Browser WAV Converter

Convert audio files directly in the browser to:

- WAV
- PCM 16-bit (`pcm_s16le`)
- Mono (`-ac 1`)
- 8000 Hz (`-ar 8000`)

This includes WAV -> WAV conversion into the exact target format.

Live site URL (after Pages deploy finishes):

`https://banditor.github.io/WAVconvert/`

## Latest conversion storage

Each successful conversion uploads to the same `latest.wav` object in
Supabase Storage with upsert enabled, so a new recording replaces the
previous one instead of accumulating files. The exact converted download
name is stored as metadata on that same object.

The Supabase project URL and browser-safe publishable key live in `config.js`.
Anonymous storage policies are limited to `SELECT`, `INSERT`, and `UPDATE`
operations on the single `latest.wav` object.

The browser also keeps the most recent converted WAV in a single local
IndexedDB record, replacing it on every new conversion. That makes the floating
`0` button download the newest file immediately in the same browser after a
conversion finishes.

The `sync-latest.yml` workflow mirrors the same Supabase object to
`latest/latest.wav` and its metadata to `latest/metadata.json` in this
repository every five minutes. Other browsers and computers use the mirrored
file from GitHub Pages with the preserved name, keeping downloads on the same
GitHub domain when other cloud storage domains are blocked.
