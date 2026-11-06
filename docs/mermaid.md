# Mermaid diagrams

`mermaid` converts a [Mermaid](https://mermaid.js.org) definition into editable Excalidraw shapes and arrows, as the editor's Mermaid import does, and saves it as a scene or renders it. Diagrams are laid out by [Pele](https://pele.run). It runs locally with the same browser as `render`, no API key needed. The browser is needed for scenes too: it measures the text so shapes fit their labels.

```bash
excalidraw mermaid flow.mmd --out flow.excalidraw
excalidraw mermaid flow.mmd --out flow.svg --elbow
echo "graph LR; A-->B" | excalidraw mermaid - --out - > flow.excalidraw

# Put the result in your workspace
excalidraw mermaid flow.mmd --out flow.excalidraw
excalidraw scenes create --name "Flow" --collection-id <collectionId> --file flow.excalidraw
```

- The format follows the `--out` extension (`.excalidraw`, `.json`, `.png`, `.svg`) or `--format`. Other extensions get an Excalidraw scene. With `--out -`, stdout carries only the scene JSON, PNG bytes or SVG markup.
- Flowcharts (including `swimlane-beta`), sequence, class, ER and state diagrams, Gantt charts, quadrant charts and timelines become editable elements. Other types, such as pie charts, become one image.
- `--elbow` draws flowchart edges and state transitions as elbow arrows. `--font-size` sets the text size (default 20).
- The `render` image options, such as `--scale` and `--theme`, apply to PNG and SVG output.
- A syntax error fails the command with the line and column to fix.
- Labels use the same fonts as `render`, including the CJK font download; see [CJK fonts](rendering.md#cjk-fonts).
