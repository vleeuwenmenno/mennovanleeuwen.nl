# Sticky package

`src/main.js` defines the widget's layout and checklist transformations.
The generic editor descriptor uses a browser-native textarea and synchronous
host-owned list continuation. It remains usable independently of descriptor refresh/failure.
The host pages at most 64 lines / 8 KiB into the package; Previous/Next reaches all
tasks while the editor retains the full note. A package event proposes a bounded
UTF-16 range edit, not a whole-note replacement;
the host checks the granted instance, account, displayed revision, projection range and full current note text.
Stale labels cannot act on newer input. UTF-8 limits preserve larger legacy notes
without truncation.
Saving source does not grant it permission or activate it.

Preview uses synthetic data. Activation is explicit. The original note ID and
existing note store remain authoritative. Calendar actions remain in the trusted
note menu/Notebook; the SDK does not expose calendar, clipboard, models or URLs.
