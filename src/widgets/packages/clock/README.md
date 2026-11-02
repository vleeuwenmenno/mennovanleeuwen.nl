# clock source package

A big digital clock that sits on the wallpaper: appearance "bare" (no card, border or
shadow) and "phone": true, so it also shows on a phone. The host formats the time for
the person's locale and settings (24 or 12 hour, seconds, how much of the date) and
passes it as input.clock; this package only lays it out. The time text uses the
"display" size, which scales with the widget's width, so resizing the widget (or a
narrow phone) rescales the clock. The widget needs no capabilities and reads no data.
Read /usr/share/mvlos/widgets/SDK.md for the vocabulary, limits and authoring.
