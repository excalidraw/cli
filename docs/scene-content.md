# Editing scene content

`scenes content put` replaces the whole scene with your file, so elements missing from the file are removed. Use it when the file is the source of truth. The file only needs `elements`; missing fields such as `version` and `appState` are filled in.

`scenes content patch` merges a partial payload into the stored scene:

- Elements merge by ID, and the higher `version` wins. Send an element with `isDeleted: true` to remove it.
- Files are added or replaced by ID.
- From `appState`, only `viewBackgroundColor` and `lockedMultiSelections` are stored.

```bash
echo '{"appState":{"viewBackgroundColor":"#f8f9fa"}}' | excalidraw scenes content patch <sceneId> --file -
```

`scenes create --file` creates a scene and fills it in one step, from a full export or a partial payload like the one above. An invalid file is rejected before the scene is created. If writing the content fails afterwards, the error names the new scene so you can retry.
