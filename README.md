# Clipboard Indicator (CONSTRUCT fork)

Clipboard Indicator keeps a clipboard history in the GNOME Shell top bar:
text and images, pinned and tagged entries, search, editing, private mode,
excluded apps and keyboard shortcuts.

This is the fork CONSTRUCT ships. Its `gnome-51` branch is upstream's v71
plus the patches below, and targets GNOME Shell 51 only.

## Changes from upstream

- **Runs on GNOME Shell 51** (upstream PR #641): the virtual keyboard comes
  from `global.stage.context.get_backend()`, since
  `Clutter.get_default_backend()` is gone, and vertical boxes set
  `St.BoxLayout`'s `orientation`, since `vertical` is gone. A failed menu
  build is logged instead of leaving the listener unstarted.
- **A corrupt cache no longer kills the extension** (upstream #589, from
  PR #620): malformed JSON in `registry.txt` is backed up and the history
  starts empty.
- **Pinned entries survive an oversize cache** (upstream #385): when the
  cache passes the size limit the history is cleared but the favorites are
  kept.
- **Paste pastes the chosen entry** (upstream #443 and #543, from PR #639):
  the clipboard is no longer reverted 50 ms after the synthetic paste.
- **No placeholder text at every unlock** (upstream #594): the display mode
  is applied before the history loads, so "Text will be here" never shows.
- **GNOME Shell 51 only**: `metadata.json` lists 51, and the compatibility
  shim for older shells is gone.
- **Repository trimmed** to what the package is built from: no screenshot,
  extensions.gnome.org zip targets, or committed `.mo` and
  `gschemas.compiled` build outputs.

## Building

spin-desktop's `recipes/gnome-shell-extension-clipboard-indicator.yaml`
installs it by hand: `*.js`, `metadata.json` and `stylesheet.css` into
`/usr/share/gnome-shell/extensions/clipboard-indicator@tudmotu.com`, the
schema into `/usr/share/glib-2.0/schemas` (compiled with the image's), and
each `locale/*/LC_MESSAGES/*.po` compiled with `msgfmt` into
`/usr/share/locale/<lang>/LC_MESSAGES/clipboard-indicator.mo`.

`make update-po-files` refreshes the template and the catalogs from the
sources.

## Attribution and license

Clipboard Indicator is by Yotam Bar-On and its contributors:
<https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator>.
The GNOME 51 port is by Joseph Sellers with Robert Mader, the cache fix by
Leonardo Gallego, the paste fix by Arlandaren.

MIT; see `LICENSE.rst`.
