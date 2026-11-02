# Weather package

This folder is the executable widget source, not an alias for a shell component.
`src/main.js` imports the closed descriptor SDK from `@mvlos/widget`.
The trusted place picker owns geocoding. Packages receive a projected forecast only
for the selected place, never arbitrary network access or a search API.

Clone in Widget Workshop, open source in Xed, save, build, preview with mocks,
then explicitly activate for an instance. Saving does not change the active revision.
See `/usr/share/mvlos/widgets/SDK.md` for limits and the staged API surface.
