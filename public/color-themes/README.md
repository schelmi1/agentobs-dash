# Color themes

The Colors picker offers **Dark**, **Light**, **Dark+**, **Light+**,
**Solarized Light**, **Monokai**, **Linux Mint**, and **Ubuntu**.
Dark is the default. Color definitions live in [index.js](index.js); they are
shared by the browser and Node tests. Visual themes control typography and
decoration, and color themes supply colors only.
Linux Mint is inspired by its terminal palette. Ubuntu uses warm charcoal
surfaces with a subtle aubergine tint and a lightened orange interaction accent.
Both are categorized as terminal palettes and work with every visual theme.

## Add a color theme

1. Copy an object in the `colors` array in `index.js` and give it a unique,
   stable lowercase ID and a display name. Keep existing IDs stable because
   browser preferences store them.
2. Replace the colors using six-digit `#rrggbb` values. For example:

   ```js
   {
     id: 'custom-dark', name: 'Custom Dark', type: 'Custom',
     description: 'A dark palette with a blue accent.',
     background: '#1f1f1f', sidebar: '#181818', card: '#252526',
     foreground: '#cccccc', muted: '#9d9d9d', border: '#454545',
     accent: '#4daafc', green: '#89d185', amber: '#cca700', red: '#f48771',
     input: '#313131'
   },
   ```

   `type` and `description` default to the VS Code attribution when omitted;
   override both for a custom palette.

   | Field | Used for |
   | --- | --- |
   | `background` | Main canvas; also determines light/dark browser controls |
   | `sidebar` | Navigation and picker surfaces |
   | `card` | Agent cards and detail surfaces |
   | `foreground` | Main text |
   | `muted` | Secondary text and inactive states |
   | `border` | Surface outlines and dividers |
   | `accent` | Selection, focus and interactive highlights |
   | `green` | Working agents, successful activity and the active left bar |
   | `amber` | Attention and warning states |
   | `red` | Failure states |
   | `input` | Search and input surfaces |

3. Add the ID to the expected catalog in `test/appearance.test.js` and update
   the documented combination count: visual themes × color themes
   (currently 6 × 8 = 48). The browser suite discovers the catalog automatically.
4. From the repository root, run:

   ```sh
   node --test test/appearance.test.js
   npm run test:modern
   ```

   Use `CHROME_BIN=/absolute/path/to/chrome` if using an existing browser.
   The browser suite exercises every theme/color combination. The Node checks validate color fields, body
   text contrast and contrast-aware ink on filled status labels. Also inspect
   secondary text, focus indicators and status bars in the browser.

The menu entry, swatch, preference support, CSS variables, hover/selection
surfaces and badge ink are generated automatically. No new CSS, server route,
script tag or dependency is needed for an additional palette.

## Removing a color theme

Remove its object and adjust the catalog expectations and documentation. Unknown
IDs fall back to Dark while keeping the selected visual theme. The
retired Paper and Quiet Light palettes explicitly migrate to
Light in `normalizeAppearance()` in `../appearance.js`; other retired palettes
migrate to Dark. Legacy combined presets use the same Dark/Light destinations.
