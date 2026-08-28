# Internet Archive for Volumio

A Volumio music service plugin that streams live recordings from [Internet Archive](https://archive.org) collections.

Browse **collection → artist → year → show → recording → tracks**. Search is also supported.

## Features
- Any live-music collection (not just etree)
- Default collections: `aadamjacobs`, `pearljambootlegs`, `NYCTaper`, `taperssection`, `etree`
- Large collections (etree, taperssection) use an A–Z artist index
- Show rows include date, venue/city, and source lineage when available
- Years and shows list newest first
- Artist names are merged case-insensitively (`Phish` / `phish`)
- Format picker (MP3 / Ogg / FLAC); Play/search defaults to MP3
- In-memory caches for artist lists and recording metadata

## Settings

Plugin settings:

| Setting | Default | Meaning |
|---|---|---|
| Collections | see above | Archive.org collection ids, comma- or newline-separated (case-sensitive) |
| Results Limit | 100 | Max shows listed for one artist/year |
| Artist Index Threshold | 4000 | Collections larger than this get an A–Z index instead of one artist list |

## Install

Copy this folder to the Volumio plugin directory (or zip it and install from the plugin manager):

```
/data/plugins/music_service/volumio-internetarchive/
```

`install.sh` installs `curl`, `jq`, and npm dependencies. Enable the plugin, then open **Internet Archive** in Browse.

Play from a **recording** (source) or a track — not from an artist/year/show folder.
