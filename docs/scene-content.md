# Editing scene content

`scenes content put` replaces the whole scene with your file, so elements missing from the file are removed. Use it when the file is the source of truth. The file only needs `elements`; missing fields such as `type`, `version`, `source`, `appState` and `files` are filled in, and the file is checked before anything is sent. The server sets `sceneVersion` itself, and editors that have the scene open reload it.

`scenes content patch` merges a partial payload into the stored scene. Prefer it for automated edits, such as an agent adding or changing specific content. Send at least one of `elements`, `appState` or `files`:

- Elements merge by ID, and the higher `version` wins; `versionNonce` breaks ties. To change an element, send it with its `version` increased. Elements you leave out are kept. Send an element with `isDeleted: true` to remove it.
- Files are added or replaced by ID.
- From `appState`, only `viewBackgroundColor` and `lockedMultiSelections` are stored.

```bash
echo '{"appState":{"viewBackgroundColor":"#f8f9fa"}}' | excalidraw scenes content patch <sceneId> --file -
```

`scenes create --file` creates a scene and fills it in one step: a full export is written as with `put`, and a partial payload like the one above is merged as with `patch`. An invalid file is rejected before the scene is created. If writing the content fails afterwards, the error names the new scene so you can retry with `scenes content put`.

`scenes content get` may return `filesFailedToEmbed`, the files the API couldn't include. `put` and `patch` ignore that field when you send the content back.
