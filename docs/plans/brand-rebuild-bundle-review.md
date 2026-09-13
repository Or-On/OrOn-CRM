# Brand rebuild — bundle review

Audit and remeasurement, 10 September 2026. The initial read-only snapshot used
Next production BUILD_ID `zjvWNghyGn2RjgmDvcBnu`; the post-optimization snapshot
uses BUILD_ID `oa4hgKB29tTvDWWR70G6p`, checked unchanged before/after measurement.
The audit itself did not launch a build or browser.

Final CSS-only verification build: `KOkGGXMNedifq8ofD8Sfv`. Compact Settings action
wrapping and call-timeline label/timestamp stacking added398 emitted CSS bytes.
Remeasurement confirms JavaScript1,257,528 and fonts366,776 bytes are unchanged;
CSS is now212,388 (+11.36% versus baseline). The detailed route-JS measurements
below remain the post-optimization snapshot; this final styling pass changed no
JavaScript source or dependency contract.

After the initial audit, the coordinating task approved the isolated
global-error copy reduction. That tiny module is implemented with two passing
synchronization tests; all six strings and rendered layout/retry behavior are
unchanged. The final build also includes the independently verified active-tab
reveal, compact Orchestration CTA, and chart-axis spacing fixes. This is not a
controlled, single-edit bundle experiment. Both snapshots are retained below.

## Method and limits

The comparison uses the baseline recorded in
[the execution plan](or-on-product-experience-2026-09-10.md#evidence-ledger).
For each `.next/server/app/**/page_client-reference-manifest.js`, take the union
of every `clientModules[*].chunks` path, map `/_next/` to `.next/`, and sum each
referenced JavaScript file's raw filesystem size once. This includes shared
chunks and error-boundary references; it excludes framework/bootstrap chunks
that are not in that union. Do not add route totals together: that would count
shared assets repeatedly.

Reproduce a route measurement from the repository root:

```js
const fs = require("node:fs");
const vm = require("node:vm");
const base = "apps/web/.next";
const scope = {};
vm.runInNewContext(
  fs.readFileSync(
    `${base}/server/app/contacts/page_client-reference-manifest.js`,
    "utf8",
  ),
  scope,
);
const manifest = Object.values(scope.__RSC_MANIFEST)[0];
const chunks = new Set(
  Object.values(manifest.clientModules).flatMap((item) => item.chunks),
);
const bytes = [...chunks].reduce(
  (total, chunk) =>
    total + fs.statSync(`${base}/${chunk.replace("/_next/", "")}`).size,
  0,
);
console.log(bytes);
```

The asset inventory separately sums all emitted `.js`, `.css`, and `.woff2`
files beneath `.next/static`, once each. Neither measurement is compressed
transfer size, parsed JavaScript cost, route navigation traffic, or Core Web
Vitals. In particular, Next's `diagnostics/route-bundle-stats.json` reports
Contacts first-load raw JS as **817,196 bytes**, not the final **378,228 bytes** below;
its broader first-load chunk set is a different metric and has no matching
recorded baseline here.

## Before isolated fallback optimization

| Emitted asset inventory | Baseline bytes | Current bytes |   Change |
| ----------------------- | -------------: | ------------: | -------: |
| JavaScript              |      1,207,674 |     1,235,209 |   +2.28% |
| CSS                     |        190,728 |       211,832 |  +11.06% |
| WOFF2                   |        122,056 |       366,776 | +200.50% |

Routes crossing the 10% review threshold in that pre-optimization build:

| Client-reference chunk union            | Baseline bytes | Current bytes | Added bytes |  Change |
| --------------------------------------- | -------------: | ------------: | ----------: | ------: |
| Overview                                |        294,472 |       324,837 |      30,365 | +10.31% |
| Contacts index and contact detail, each |        341,959 |       377,320 |      35,361 | +10.34% |
| Operations / messaging                  |        303,767 |       338,895 |      35,128 | +11.56% |
| Global error                            |         99,536 |       116,014 |      16,478 | +16.55% |

Other measured route groups: Inbox 351,632 (+8.72%); Pipeline 329,571 (+9.14%);
Voice/campaigns/call detail/flows 350,603 (+9.46%); Orchestration 525,324 (+6.60%);
Settings 341,665 (+9.20%); Health 327,670 (+9.41%); Start/localized/not-found 321,836
(+9.29%); Login 323,139 (+9.01%); Invite 323,310 (+9.00%).

## Initial findings, supported by the pre-optimization emitted code

- **Shared cost is repeated in route measurements.** Even Start/localized/
  not-found gain 27,364 bytes while the entire unique JS inventory gains 27,535.
  Shared shell/control and bilingual-message chunks are referenced on many
  routes. Route percentage changes are therefore not independent additions
  to the deployment. Historical baseline chunks were not retained here, so
  exact byte attribution of each change to each source edit is not possible.
- **Global error pulled both complete translation dictionaries.**
  At the initial snapshot, `src/app/global-error.tsx` imported all of `en.json` and `he.json` to render
  only the two error titles, two descriptions, and two retry labels. Its
  emitted union is `05hr3cg5oapro.js` (16,184 bytes) plus
  `2vvm49ac20c2s.js` (99,830 bytes). The latter contains both full dictionaries;
  compact serialization of their source data is 99,610 bytes, versus 436 bytes
  for the six required fallback strings. This same dictionary chunk appears
  in other routes' client-reference unions. The redesigned bilingual copy
  has a broad bundle impact, not just a global-error visual styling cost.
- **Contacts index/detail remain bundled together.** Both pages import the
  contacts barrel; both manifests register `contact-manager.tsx` and
  `contact-detail-panel.tsx` with identical chunk lists. Their common
  `053b2a7npvp8h.js` is 26,717 bytes. Detail also imports `voiceMutation` from
  the Voice barrel, which exports multiple client views; Contacts references
  the 28,767-byte `0hiqfqkh3x9__.js` Voice-related chunk. The directory therefore
  does not have a clean feature-only client boundary today.
- **Operations and Overview gained real presentation/interaction code.**
  Operations statically imports both the campaign and automation views plus
  controlled creation dialogs; Overview adds a small React daily-message
  inspector and accessible data view. No new chart library was introduced
  for that inspector. Their totals also include the shared costs above.
- **CSS growth is 21,104 raw bytes.** The root layout imports shared UI and all
  product stylesheet families, including the flow-canvas stylesheet. The
  rebuild adds the anchored picker/popover/combobox treatments, responsive
  compositions, RTL cases, and reduced-motion rules. This is globally emitted
  CSS growth, not a measured per-route rendering slowdown.

## Post-optimization measurements

The same manifest-union method was rerun on final BUILD_ID
`oa4hgKB29tTvDWWR70G6p`. Values are raw bytes; the last column compares the final
build with the original pre-redesign baseline, not with the intermediate build.

| Emitted asset inventory |  Baseline | Before fallback extraction |     Final | Final vs baseline |
| ----------------------- | --------: | -------------------------: | --------: | ----------------: |
| JavaScript              | 1,207,674 |                  1,235,209 | 1,257,528 |            +4.13% |
| CSS                     |   190,728 |                    211,832 |   212,388 |           +11.36% |
| WOFF2                   |   122,056 |                    366,776 |   366,776 |          +200.50% |

| Client-reference chunk union            | Baseline | Before fallback extraction |   Final | Final vs baseline |
| --------------------------------------- | -------: | -------------------------: | ------: | ----------------: |
| Overview                                |  294,472 |                    324,837 | 226,043 |           −23.24% |
| Contacts index/detail, each             |  341,959 |                    377,320 | 378,228 |           +10.61% |
| Operations / messaging                  |  303,767 |                    338,895 | 339,917 |           +11.90% |
| Global error                            |   99,536 |                    116,014 |  16,584 |           −83.34% |
| Inbox                                   |  323,426 |                    351,632 | 352,654 |            +9.04% |
| Pipeline                                |  301,982 |                    329,571 | 230,763 |           −23.58% |
| Voice/campaigns/call detail/flows, each |  320,300 |                    350,603 | 351,625 |            +9.78% |
| Orchestration                           |  492,797 |                    525,324 | 526,346 |            +6.81% |
| Settings                                |  312,875 |                    341,665 | 342,687 |            +9.53% |
| Health                                  |  299,475 |                    327,670 | 228,862 |           −23.58% |
| Start/localized/not-found, each         |  294,472 |                    321,836 | 223,028 |           −24.26% |
| Login                                   |  296,436 |                    323,139 | 224,331 |           −24.32% |
| Invite                                  |  296,607 |                    323,310 | 224,502 |           −24.31% |

Global error now references only `1hnxu0ycvrvul.js` (16,584 bytes), a measured
99,430-byte reduction from the intermediate build. Overview and the other
simple routes no longer inherit the full bilingual dictionary dependency from
that boundary. The broader Next first-load diagnostic for Overview likewise
changes from 763,805 to 665,011 raw JS bytes; no compressed transfer or timing
improvement is claimed.

Contacts and Operations remain above the 10% review threshold. Their actual
source imports `i18n/error-message.ts`, which independently imports both complete
dictionaries to recognize already-localized errors retained across locale
changes; Contact Detail also imports `activity-label.ts`, which imports the
English dictionary for valid status keys. Those existing recovery/locale
contracts were deliberately not changed during the fallback-only optimization.
Contacts' directory/detail and Voice barrel coupling also remains as recorded
above. These dependencies plus the added route/shared interaction code explain
why those routes do not receive the same reduction as Overview/global error.

**The unique emitted JS inventory increased by 22,319 bytes between the two
rebuild snapshots.** Therefore the improvement is to specific route dependency
sets, not a reduction in total deployed JavaScript. Chunk grouping changed and
the final build also includes the separate verified UI fixes named above;
without an isolated rebuild per change, do not assign that inventory difference
solely to the fallback extraction. The final global JS inventory is still
within 10% of the original baseline; CSS and fonts are disclosed exceptions.

## Fonts: deployment bytes are not one page's downloads

The verified brand uses Inter, Poppins 600, and Heebo; the final layout declares
only that Poppins weight. The current output contains 15 font files and includes
unicode-ranged language/math/symbol subsets beyond the preloaded subsets.
The current font manifest preloads only three files, totalling 68,424 bytes:
Inter Latin 48,432; Poppins Latin 7,992; Heebo Hebrew 12,000.

The real-browser evidence in
`.artifacts/brand-rebuild/interaction-workspace.json` records **153,696 encoded
font bytes for the tested EN pages** (four resources) and **113,368 for HE**
(five resources). EN additionally loads Inter Latin Extended 85,272; HE
additionally loads Heebo Latin 30,148 and Latin Extended 14,796. These are
observed mixed-content pages, not guarantees for every contact name, currency,
locale, or warm-cache navigation. The EN Latin Extended range includes U+20AA
(the shekel symbol); it is unsafe to assume this file is unused simply because
the interface locale is English. The 366,776 emitted total must not be described
as the font transfer on each page, nor should the smaller observed transfer
hide the +200.50% deployed-font increase.

## Low-risk reductions to evaluate separately

1. **Completed: isolate global-error's six fallback strings.**
   `src/i18n/global-error-messages.ts` is independent of the normal
   locale/provider tree. Two synchronization tests check it against the
   authoritative dictionaries. Final route measurement confirms the reduction
   above; total emitted JS and unmeasured network performance are not presented
   as savings.
2. **Use explicit Contacts component entry points and the pure Voice mutation
   entry point.** Split the directory/detail server imports and import
   `voiceMutation` from `voice/mutation`, not the all-view barrel. Preserve
   all permissions, request contracts, and dialogs. Confirm the next manifest
   no longer registers irrelevant client boundaries; tree-shaking savings
   are not guaranteed without that evidence.
3. **Evaluate locale-aware font preload or carefully scoped local subsets.**
   Preserve all three approved brand families, Hebrew, punctuation, currency,
   and arbitrary user-data glyph coverage. First distinguish unused preload
   from fonts actually used after layout. Do not simply remove Latin Extended
   or Hebrew files. Any custom subset requires licensing/glyph inspection and
   fresh bilingual layout/CLS evidence; this is less trivial than the two
   import-boundary changes above.
4. **Consider lazy secondary editors only after the above.** Operations' inactive
   tab/editor content and route-only canvas CSS are potential later boundaries,
   but changing their mounting/loading can break retained drafts, focus, and
   CSS ordering. They are not recommended as an unverified last-minute fix.

The remaining >10% results—Contacts +10.61%, Operations +11.90%, CSS +11.36%,
and emitted fonts +200.50%—are disclosed review exceptions, not a silent
bundle-budget pass. This audit explains their scope and identifies concrete
follow-up work; it does not claim measured latency improvement or authorize
further source changes during the final visual verification run.
