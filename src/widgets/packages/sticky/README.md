# Sticky package

`src/main.js` defines the widget's layout and checklist transformations.
The generic editor descriptor uses a browser-native textarea and synchronous
host-owned list continuation. A package event can propose a note replacement;
the host checks the granted instance, account, revision and current note text.
Saving source does not grant it permission or activate it.

Preview uses synthetic data. Activation is explicit. The original note ID and
existing note store remain authoritative. Calendar actions remain in the trusted
note menu/Notebook; the SDK does not expose calendar, clipboard, models or URLs.
