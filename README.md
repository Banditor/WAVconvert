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

The floating `0` button downloads the most recently converted file from
Supabase Storage. Each successful conversion uploads to the same
`latest.wav` object with upsert enabled, so a new recording replaces the
previous one instead of accumulating files.

The Supabase project URL and browser-safe publishable key live in `config.js`.
Anonymous storage policies are limited to `SELECT`, `INSERT`, and `UPDATE`
operations on the single `latest.wav` object.
