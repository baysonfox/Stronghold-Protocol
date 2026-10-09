# 干员皮肤

*This fork's integration of the Paper-Yuan fusion skin system onto upstream `sganggs/Stronghold-Protocol`.
Everything below describes what the `fusion-assets` branch actually ships.*

## What this is

Players choose a **skin** per operator on the 干员调配 screen; every player's pieces render with the chosen
model — their own view, the teammates' views of them (the choice is public), the prep scout and the battle
field alike. The choice is per browser, persisted in `localStorage`, mirrored to the server through
`room.skins`, and carried by the match into every `UnitInfo` (battle), `prepFieldMeta` (board / hand / temp)
and `m.public.players[]` (the public selection).

The shipped set: **271 skins over 172 operators** (Paper-Yuan v0.2.1-fusion's installed set) — avatars
(180×180) and the battle Spine models (Front, Back where one exists) under `public/assets/`:

```
public/assets/char/skin_avatar/<sanitized skin id>.png        avatar of each skin
public/assets/spine/op/<charId>/<sanitized skin id>/front|back/{stem}.skel/.atlas/.png
```

(`@` / `#` of a skin id are flattened to `_` in file names — `char_263_skadi@marthe#5` →
`char_263_skadi_marthe_5`.)

## Data flow

```
data/skins.json                the catalogue: every skin the project knows (id / name / group), no URLs
data/assets.json               chars[charId].skins = { [skinId]: { name, avatar, spine: { front, back? } } }
                               (injected by tools/integrate-fusion-assets.mjs onto the upstream build;
                                docs/research/08-skins.json is the research table behind it)

public/js/ui/skins.js          the per-browser choice (store + localStorage) and installSkinsSync:
                               room.skins { skins } — same debounce/retry wiring as the loadout, but PUBLIC
public/js/ui/skinPicker.js     the 皮肤 section of the loadout detail panel (the radiogroup)
public/js/render/app.js        pieceInfo() adds this browser's choice (skinFor) to each own piece;
                               the view signature carries the skin — a change rebuilds the view
public/js/render/units.js      spineEntry(id, { skin }) / avatar(id, { skin }) draw the chosen model;
                               a skin model that fails to load falls back to the default one (entry.fallback)
server/lobby.js                freezeSkins keeps known chess ids + char_*/DIY keys; seats[].skins
server/match/…                 PlayerState.skins, Match.setSkins (no phase gate — cosmetic), battleInput
                               u.skin (base-chess keyed; a DIY slot wears its pick's skin; a stand-in keeps
                               the stand-in's model), unitInfo.skin (undefined-when-absent: a battle with no
                               skins stays byte-identical — the DESIGN §8.2 wire contract)
```

### The protocol message

`room.skins { skins }` — `skins` is a map of ≤ 160 entries `{ [baseChessId]: skinId }`. Skin ids carry `@`
and `#` (`char_002_amiya@winter#1`), so they are checked by `isSkinId` (shared/protocol.js), **not** `isId`.
Accepted in any room phase and during a running match (unlike `room.loadout`, a skin is cosmetic and public:
the server hands it to `Match.setSkins`, which marks the public view dirty so the teammates' renderers
follow). Stored on the session (follows the player into rooms, survives a resume) and on the seat.

Bots always wear the default model (`seats[].skins` is null for them).

## Voices are NOT part of this

Upstream 0.2.2 carries its own, more complete dub trees (`audio.voice` / `audio.voiceJp`, 191 operators
each, the 语音语言 setting in `public/js/ui/settings.js`). The fusion release's bilingual restructure
(`audio.voice.{jp,cn}`) is **not** integrated; only its BGM ducking is (`audio.js duckBgm`: a voice line
plays over ~35 % BGM for 1.8 s, then a smooth restore).

## Rebuilding the manifest

```
npm run assets                                        # the upstream build (authoritative base)
node tools/integrate-fusion-assets.mjs --strict       # inject skins/skills, verify every URL on disk
node tools/normalize-skin-atlases.mjs                 # after copying fresh fusion atlases (pre-4.0 pages)
```

`tools/integrate-fusion-assets.mjs` is idempotent and never shrinks the upstream entries — modules,
per-unit SFX, enemy run/skills animations, token spineLocal overlays and the voiceJp tree all stay
authoritative. See its header for the exact rules.

## Tests

- `test/lobby-skins.test.js` — the protocol end to end: malformed maps BAD_MSG, @/# ids accepted, session /
  seat storage, seats[].skins at the match start, the mid-match hand-off to `Match.setSkins`, bots none.
- `test/ui/standin-ui.test.js` — the bench view signature carries the skin.
