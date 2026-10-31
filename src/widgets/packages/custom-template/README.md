# Daily tally (custom widget starter)

A custom widget: a counter that starts again each day and remembers its all-time total.

- `manifest.json`: id, name, entry, size and capabilities. `custom.state` gives the widget
  a small saved state (at most 4 KiB of JSON) that it reads as `input.custom.state` and
  replaces through an explicit `custom.replace` effect.
- `src/main.js`: `render(input)` returns the layout, `event(input, name)` handles a button.
- `styles/tokens.json`: spacing tokens only. Colours come from the theme.

Edit `src/main.js` in Xed, then in the Widget Workshop use Build & mock preview and
Activate as new widget. Read /usr/share/mvlos/widgets/SDK.md for the full reference.
