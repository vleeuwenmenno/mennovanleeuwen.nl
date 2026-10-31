# agenda source package

This folder owns display composition in src/main.js and runs through the shared
verifier, QuickJS worker and closed descriptor renderer. The broker supplies typed
projections and opaque, presentation-bound resource handles only. Native user
actions resolve handles; package code never receives URLs, provider refs or functions.
Read /usr/share/mvlos/widgets/SDK.md for scopes, limits and authoring.
