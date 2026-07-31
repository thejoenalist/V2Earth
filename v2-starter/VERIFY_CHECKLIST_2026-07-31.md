# Verification Checklist — 2026-07-31

Successor to `VERIFY_CHECKLIST_2026-07-14.md` (which **does** exist on disk in
`v2-starter/` — an earlier note claiming it was missing was wrong; it was
looked for at the repo root instead of inside `v2-starter/`). The 07-14 file
is still the authority for its own §2/§4 render items, reproduced here where
still owed.

Rules that apply to everything below:

- The Cowork Linux mount **cannot execute** `npm run verify` or `py_compile`
  and truncates large files on read. Static checks must be run on the Windows
  machine.
- Two-machine hygiene: `git pull` before starting, `push` before stopping. If
  git reports the remote moved ahead, diff the result before trusting it
  (this is where the duplicate `flyToISO` came from).

---

## 1. Re-verify the two most recent changes

These are the freshest edits and the highest-value checks.

- [x] **Console is clean** on a hard-reloaded production load — no CSP
      violations, no Cesium `importScripts` / worker errors. CSP lives in
      `v2-starter/public/_headers` (there is no `netlify.toml`); the worker
      directive currently reads `worker-src blob:`.
- [x] **Consent banner timing** — fresh incognito load: the banner must be
      hidden on first paint and reveal only **after** the "Explore the Earth"
      onboarding button is dismissed. It must not cover that button.
      Source: `src/ui/ConsentBanner.js` (`revealIfNeeded()`), called from
      `src/main.js` on onboarding dismiss.
- [x] **Footer Contact link** — the footer "Contact" entry resolves to
      `mailto:thejoenalist@gmail.com` (`index.html`, footer-links block).
      Inspect the `href`; no need to actually open a mail client.
- [ ] **Close the doc loop** — with a contact channel now live, update
      `public/privacy.html` and `public/terms.html`: both currently point
      deletion/contact requests at "the contact address published on the site
      footer", which had no address until this change. Make the wording
      concrete (or link the mailto directly), then bump `CONSENT_VERSION` in
      `src/core/ConsentState.js` to the new privacy.html "Last updated" date
      so the banner re-shows on the material change, as promised.

## 2. Static checks (Windows machine only)

```
cd v2-starter
npm run verify
python -m py_compile pipeline/bake_all.py pipeline/validate.py \
       pipeline/bake_geodata.py pipeline/bake_tracks.py \
       pipeline/bake_city_elevation.py pipeline/bake_landmask.py
python pipeline/validate.py       # expect PASS
```

Nothing is "done" until `npm run verify` is green locally.

## 3. Render eyeball pass — still owed from 07-14 §2/§4

Type each into the app's chat and look at the globe.

Hurricane (analog track + surge):

- [ ] "hurricane in New Orleans" → Katrina track + surge polygons (CI bake
      should have replaced the hand-seeded track-only file)
- [ ] "hurricane in Miami" → Andrew track + surge
- [ ] "hurricane in NYC" → Sandy track + surge
- [ ] "hurricane in Houston" → Ike track + Galveston Bay surge
- [ ] "hurricane in Dhaka" → Sidr track, **no surge** (track-only by design)
- [ ] "hurricane in Norfolk" → Isabel track (wave-3)
- [ ] "hurricane in Shanghai" → In-fa track (first WP-basin entry — check the
      run log for a name+season SID fallback)

Sea level rise (baked inundation delta):

- [ ] "sea level rise in Miami" → delta-band polygons + baked `area_km2`
      label; the +7 s close-up should fly to a genuinely low-lying city now
      that `mean_elev_m` is backfilled (Miami ≈ 3.3 m), not the fallback
- [ ] "sea level rise in Jakarta" / "Houston" / "Lagos" / "Rotterdam"
      (Rotterdam should carry the below-sea-level / Delta Works caveat)

Wildfire placement (desert exclusion + city-biased anchor):

- [ ] "wildfire in Australia" → fire near Sydney, **off** the Outback, with
      the "illustrative placement — country-level query" line
- [ ] "wildfire near Alice Springs" → still the Centre (explicit place wins)
- [ ] "wildfire in Mongolia" → off the Gobi

Heatwave intensity (rule #4 re-mapping):

- [ ] "heatwave in India" at **Today** vs **2100 SSP5-8.5** → visibly
      different shimmer/ring intensity, and 2025 is still perceptible (the
      first mapping made it invisible)

Generic template (schema/noted tier):

- [ ] "tornado in Oklahoma" → local ellipse, NOT nationwide
- [ ] "crop failure in India" → national polygon + "national extent shown —
      not a modeled footprint"
- [ ] "coral bleaching in Australia" / "marine heatwave in Japan" → ocean mode
- [ ] "solar storm" → honest scope disclosure, and **no** placeholder circle
      drawn mid-Atlantic
- [ ] Eject ("start over") after a generic event → no leftover entities

Every one of these: on-screen numbers must be baked-data numbers with a
`(CMIP6 <ssp>)` tag, never parser magnitude.

## 4. Optional cleanup

- [ ] Delete the leftover Supabase RLS test row (`sessionId
      rls-test-2026-07-05`).
- [ ] Anthropic console spend cap (last open item under cost controls).

---

## Results — 2026-07-31 run

**§1 browser checks: ALL THREE PASS on production.** Run against
`https://chipper-faun-a051b1.netlify.app` in a Brave private window, DevTools
console set to **All levels**, operator driving / Claude reading the screen
(the Claude-in-Chrome extension does not support Brave — Chrome only — and
sandbox fetches to the Netlify URL timed out, so the hybrid method was used).

- ✅ **Console clean.** Exactly one error, `/favicon.ico 404`. No CSP
  violations, no Cesium `importScripts` or worker errors; the Issues tab read
  **No Issues** — that is where Chromium files CSP blocks, so nothing was
  blocked. The globe, terrain and imagery all rendered, which independently
  proves production is serving the `blob:`-inclusive `script-src` from
  `public/_headers`: Cesium's blob-bootstrapped workers could not have started
  otherwise. **The stale `dist/_headers` never reached production** — Netlify
  rebuilt from source, as the push-to-main flow intends.
- ✅ **Consent banner timing.** Absent on first paint (bottom strip zoomed to
  confirm — only the dimmed chat bar, timeline and footer behind the
  onboarding overlay), so it does not cover "Explore the Earth". After
  clicking through, it reveals above the chat bar, covering nothing.
- ✅ **Footer Contact.** Hover status bar reads exactly
  `mailto:thejoenalist@gmail.com`.

### §3 render eyeball pass — operator run, 2026-07-31

`npm run verify`: **OK — 0 failures, 0 warnings** (real machine). Renders run
against `localhost:5173`.

Passing: **SLR Miami** (close-up zoom lands well — clear pass), **wildfire
Australia** (fire near Sydney, off the Outback, baked label reading
`+0.8 °C anomaly (CMIP6 SSP5-8.5)` + `+7.7 % precip` + `Sydney — 4.6M`; note
the wildfire branch correctly withheld the "drier fuels" clause because precip
is positive).

#### Finding A — hurricane spiral washes out the close range (Norfolk, Shanghai)

Symptom: the analog track and category dots render correctly, but at the
altitude where the surge polygons and labels live, the storm is a flat white
mass — surge extent, the "historical analog — not a forecast" line and the
storm-surge label are all unreadable against it.

Root cause is **not** the labels: they already carry black outlines
(`_addStatLabel`, and the track/surge labels both use `outlineColor: BLACK,
outlineWidth: 2`). It is the spiral geometry. `_renderHurricane` builds five
`LAYERS` of ground-anchored white ellipse bands at alpha 0.62 → 0.15, plus a
**white eyewall at alpha 0.75**, at heights 500–12,500 m. From orbit that
reads as a hurricane; at close range the bands fill the frame with flat white
and everything underneath disappears.

**FIX APPLIED, two rounds:**

Round 1 — camera-distance cloud fade. Every white cloud entity (eyewall, the
10 band ellipses, inner deck, outer envelope) now takes its material from a
`cloudMaterial()` helper whose alpha is multiplied by `cloudFade.val`. Full
opacity at/above `stormR × 3` (the flyTo lands at `× 3.5`, so the orbit view is
unchanged), floor below `× 0.9`. The fade rides on the **existing** rotation
postRender listener — no second listener (2026-07-12 perf note). The dark eye
keeps a static color; it aids legibility rather than hurting it.

Round 2 — after eyeballing round 1, terrain and track read through the deck but
**labels were still washed out**: thirteen overlapping cloud entities composite
to a haze that a 2 px outline cannot survive. Added module-level `LABEL_PLATE`
(dark `#0b1220` @ 0.62 background + padding) spread into all five on-globe label
sites — the shared `_addStatLabel` (heatwave/drought/wildfire/conflict/generic),
plus the hurricane category, SLR-baseline, analog-track and surge labels. The
two 11 px hurricane labels went to bold 12 px. `CLOUD_MIN_ALPHA` also dropped
0.12 → 0.05, since the per-layer floor multiplies out across overlaps.

Presentation only — no displayed number changed (rule #4).

Tuning knobs if it still isn't right: `CLOUD_FADE_NEAR`, `CLOUD_MIN_ALPHA`, and
`LABEL_PLATE.backgroundColor` alpha.

#### Finding B — comparative / multi-place queries render nothing

Two separate symptoms, **one root cause**:

- "Sea level rise in Lagos and in Rotterdam" → prose only, no geometry, camera
  never moved (still framing East Asia from the previous Shanghai run).
- "Heatwave: Today vs 2100" → prose only. The globe did desaturate to the
  late-century palette, so the chapter moved, but no heatwave layer appeared.

Not a data problem: **lagos and rotterdam are both registered flagship metros**
(`InundationGeodata.FLAGSHIP_METROS`) and their `slr_*.json` bakes landed on
2026-07-16. The failure is upstream in `EventSimulator._onRequested`:

```js
if (command.type !== 'climate_event' || !incomingEvent) return;
```

`explain` has no globe behavior by design, so any phrasing the parser routes to
`explain` is a visual dead end. "A and B" and "X vs Y" are extremely natural
ways to ask, and both currently produce a chat answer over an unchanged globe —
which reads as the app being broken.

**DIAGNOSED 2026-07-31:** "sea level rise in Lagos" **alone renders the full
flagship path** — delta-band polygons, `Nearest: Lagos (1 km)`, baked `+0.09 m`
and `32.4M (14%)`, bathtub + 30 m DEM caveats. Same metro, same bake, different
phrasing. So the parser type is the whole story: "Lagos **and** Rotterdam"
never reached the simulator.

**FIX APPLIED (prompt-side, "first place wins"):** added a CRITICAL RULE to
`SCENARIO_PARSER_SYSTEM_PROMPT` — a named hazard always returns `climate_event`;
never `explain` merely because two places, times or pathways are mentioned;
anchor on the FIRST named place and cover the rest in the narrative. `explain`
is reserved for queries naming no hazard and no place. Worked examples for all
three failing phrasings are in the prompt.

**Sync + deploy DONE 2026-07-31.** `npm run verify` failed once on the
edge-function sync check (expected — prompt edited, not yet synced),
`npm run sync-prompt` rewrote
`supabase/functions/parse-scenario/index.ts`, and after `npx supabase login`
the function deployed to project `silryqzempbblleqaokv`. Dev server restarted on
5173 (failure mode #8: `devParseScenarioPlugin.mjs` imports the prompt once at
startup).

**Note on what `verify` actually proves here.** Its edge-function check compares
`SimulationCommand.js` against the local `index.ts` — **file parity, not
deployed parity**. `sync-prompt` alone turns it green, so a passing verify does
NOT establish that the live function is current. Treat "sync-prompt succeeded"
and "deploy succeeded" as two separately-confirmed facts; this gap is how the
prompt once drifted 12 events behind.

**Two delivery paths for this session's fixes:**

| Fix | Reaches production via | Live now? |
|---|---|---|
| B (prompt routing) | edge-function deploy | ✅ yes |
| A (cloud fade + label plates) | commit → push → Netlify rebuild | ❌ not yet |
| C (placeholder scope guard) | commit → push → Netlify rebuild | ❌ not yet |

Fix options (need a decision — see Finding B note in chat):

1. Prompt-side: teach the parser to emit `climate_event` for the first named
   place and treat the second as context, or emit `scenario_compare` for
   `X vs Y` time phrasings. Requires `npm run sync-prompt` **and** an edge
   redeploy (failure mode #1).
2. Simulator-side: let `explain` carry an optional target and, when it does,
   at least fly the camera there. Cheaper, no edge redeploy, but only fixes
   the camera — no hazard geometry.
3. Multi-target: render both places as two stacked simulations (within the
   max-3 budget). Most faithful to what the user asked; most work.

#### Finding C — solar storm still draws a fabricated footprint

The 2026-07-16 fix is present but doesn't cover this path. `_renderPlaceholder`
guards with:

```js
const hasAnchor = (p?.center?.lon != null && p?.center?.lat != null)
  || !!getCentroid(this.command.target);
if (!hasAnchor) return;
```

On this run `hasAnchor` was **true** — the parser invented a center in the Gulf
of Guinea, so a 250 km circle drew in open ocean anyway. The "Nearest: Accra
(618 km) · Lomé (695 km) · Abidjan (741 km)" readout is the tell: that is
essentially null island. The guard tests whether a center *exists*, not whether
a localized footprint is *meaningful* for the event.

**FIX APPLIED:** `_renderPlaceholder` now returns early on
`EVENT_TYPES[eventType].status === 'non_climate'`, **before** the anchor check.
Scope decides, not anchor presence, so an invented parser center can no longer
resurrect the circle. The original no-anchor guard stays for everything else.
(Operator called this one "ok" on screen; fixed anyway because it violates rule
#4's spirit — a drawn circle asserts a location the data does not support.)

#### Finding D — simulation labels and the panel can show different SSPs (NEW)

Found on the post-fix Lagos re-eyeball. One screen showed the **same quantity
twice with two different pathways**:

- on-globe label: `Lagos — Sea Level Rise · +0.63 m by 2075 (CMIP6 SSP5-8.5)`
- "By the numbers" card and the Nigeria CountryPanel: `+0.44 m · CMIP6 SSP2-4.5`

Both numbers are baked and each is correctly tagged, so this is **not** a rule #4
violation — nothing fabricated. It is a **read-time skew**:

`ActiveSimulation` takes `year` and `ssp` as constructor arguments
(`EventSimulator` passes `this._time.year` / `this._time.ssp`) and then
**never subscribes to `time:changed` or `ssp:changed`** — confirmed, there is no
`EventBus.on` anywhere in the file. So its labels are frozen at the moment the
simulation was created, while the CountryPanel and the chat card keep following
TimeController. Any SSP change after creation splits the display.

This is easy to hit: `EventSimulator._sweepScenario` calls `setSSP` twice for
`scenario_compare`, the SSP toggle is one click, and a simulation lives on the
globe for three minutes — plenty of time to drift.

Architecture note: rule #4 says layers never read time directly, they listen to
`time:changed`. `ActiveSimulation` is not a `LayerContract` layer, so it is not
literally in breach, but it is the same hazard the rule exists to prevent.

**FIX APPLIED — "pin and say so" (operator's call).** The snapshot behavior is
kept deliberately: it is the scenario the user asked for, and restarting it
mid-view would be worse. What changes is that the app now says so.
`_startScenarioPinWatch()` subscribes to `time:changed` and `ssp:changed`; when
either diverges from the snapshot, `_setScenarioPin()` adds an on-globe notice —

> 📌 pinned to the scenario you asked for — SSP5-8.5 · 2075
> the side panel follows the timeline

— and removes it again if the timeline returns to the pinned values. The
unsubscribe closure is pushed onto the existing `this._listeners` array, so
`destroy()` already tears it down (memory contract, failure mode #3), and the
label goes through `_track()` with the `_owned` filter kept in sync on removal.

Rejected alternatives: re-rendering on change (visually restarts the scenario)
and freezing the SSP toggle while a simulation is live (removes a user control).

#### Post-fix verification, 2026-07-31 (operator, localhost:5173)

- ✅ **Finding A verified.** Hurricane Norfolk at 2100: `Hurricane Cat 3`, the
  `+0.51 m baseline sea level … adds to storm surge` line, `Storm surge — ~6.5 m
  (category-typical, bathtub)` and `Isabel (2003) — Cat 5 peak / historical
  analog — not a forecast` all render on dark plates and are readable through a
  visibly thinner cloud deck. *Minor leftover:* the surge label and the Isabel
  label overlap each other at this zoom — a label-offset nudge, not a contrast
  problem.
- ✅ **Finding C verified.** "solar storm" draws no circle at all; the chat
  scope disclosure carries the content, as intended.
- ✅ **Finding B verified end to end.** "Sea level rise in Lagos and in
  Rotterdam" renders Lagos with delta-band polygons and discusses both cities
  in the narrative.
- ✅ Label plates confirmed working on heatwave (Nouakchott) and wildfire
  (Adelaide) too — the shared `_addStatLabel` path.

#### Finding E — the wildfire country-level caveat never fires (NEW)

The "illustrative placement — country-level query" line was missing again on the
second Australia run, and the run also placed the fire in the arid interior with
`Nearest: Adelaide (1166 km)` — where the first run had put it near Sydney
(3 km). Same query, different placement.

Likely mechanism: the city-biased anchor and its caveat only engage for
country-level queries with **no parser center**, but the system prompt says
`center is NEVER null for climate_event`. So the parser always supplies a
center, the explicit-place branch always wins, and `largestCityForISO()` plus
its honesty line are effectively unreachable for parser-driven queries. What is
left is whatever centroid the LLM invented that run, nudged to the nearest
burnable cell — which is why placement is unstable between runs and can land
1,000 km from anyone.

Note this predates the 2026-07-31 prompt change (the never-null rule is older);
the prompt edit did not cause it, though it did not help either.

Worth deciding: either have the parser omit `center` for whole-country queries
so the city-bias path can do its job, or treat a center that is very far from
any populated place as country-level and re-anchor. Not yet fixed.

### Follow-ups opened by this run

- [ ] **Consent banner copy is inaccurate.** It reads "Nothing is saved on
      your device between visits", but the consent flag itself persists in
      localStorage as `accepted:<CONSENT_VERSION>` — it must, or the banner
      would reappear every visit. This is the one approved localStorage
      exception (DECISIONS.md), so the behavior is right and the sentence is
      wrong. Suggested replacement: *"The only thing saved on your device is
      your answer to this question."* Accurate, still reassuring, and it makes
      the version-bump re-prompt legible to a reader. Note the 2026-07-16
      copy-vs-code pass missed this one.
- [ ] **No `favicon.ico` in `public/`.** Cosmetic, but it is the only console
      error on a clean load, which makes every future console check ambiguous.
      Adding one makes "console is silent" a binary result.

What was verified from the working copy:

- ✅ `index.html` footer-links block contains
  `<a href="mailto:thejoenalist@gmail.com">Contact</a>`, and the built
  `dist/index.html` carries it too. So the change is real in source and in the
  local build; only the *deployed* copy is unconfirmed.
- ✅ Consent gating is wired as intended in source: `ConsentBanner` is
  constructed early (`src/main.js:102`) but only `revealIfNeeded()` is called
  on onboarding dismiss (`src/main.js:106`), with the comment at
  `src/main.js:99` naming the exact bug ("otherwise it covers Explore the
  Earth"). `revealIfNeeded` is present in the built bundle. Runtime timing
  still unconfirmed.
- ✅ `VERIFY_CHECKLIST_2026-07-14.md` exists in `v2-starter/` — the earlier
  "not on disk" note was a false alarm.

### ⚠ Finding — stale `dist/_headers`

`dist/_headers` is a 2026-07-03 copy and its CSP **differs from source**:

```
public/_headers   script-src 'self' 'unsafe-eval' blob:
dist/_headers     script-src 'self' 'unsafe-eval'          ← missing blob:
```

`blob:` in `script-src` is what Cesium's blob-bootstrapped workers need;
`worker-src blob:` alone does not cover the worker's own script load, and this
is exactly the directive whose absence produces the CSP / `importScripts`
console errors §1 is checking for.

This is only a live problem if the site is ever deployed by uploading `dist/`
by hand (which has happened at least once — see CLAUDE.md's Netlify note).
The normal push-to-main flow makes Netlify rebuild from `public/`, which is
correct. Either way:

- [ ] Run a fresh `npm run build` and confirm `dist/_headers` matches
      `public/_headers` before any manual deploy.
- [ ] Confirm the **served** header on production with
      `curl -sI https://chipper-faun-a051b1.netlify.app | grep -i content-security`
      — that single command settles whether prod has `blob:` and therefore
      whether the console-clean check can pass at all.
