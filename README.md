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

When the `0` button runs in another browser, it checks the cloud copy, the
GitHub Pages mirror, and the raw file on `raw.githubusercontent.com`. After a
successful cloud upload, the browser invokes the `mirror-latest` Supabase Edge
Function, which commits the latest WAV and metadata to GitHub immediately. That
lets other devices download the newest file from GitHub Raw without waiting for
the GitHub Pages deployment queue.

The `sync-latest.yml` workflow mirrors the same Supabase object to
`latest/latest.wav` and its metadata to `latest/metadata.json` in this
repository every five minutes as a scheduled fallback. The mirrored copy keeps
normal downloads on the same GitHub domain when other cloud storage domains are
blocked.

## Supabase Edge Function

The `mirror-latest` function lives at `supabase/functions/mirror-latest`. It
runs in the accessible Supabase project `hllmzrddzygymsezlzlv`, reads the
single latest object from the storage project configured in the function, and
commits these two files to the repository in one Git commit:

- `latest/latest.wav`
- `latest/metadata.json`

Deploy it with Supabase CLI after setting a GitHub token secret:

```sh
npx supabase secrets set GITHUB_TOKEN=<github-token> --project-ref hllmzrddzygymsezlzlv
npx supabase functions deploy mirror-latest --project-ref hllmzrddzygymsezlzlv --no-verify-jwt
```
