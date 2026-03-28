# CSS Tree AST Viewer

Focused CSS AST explorer Paste or write your CSS in one pane and inspect the parsed `css-tree` structure in a second pane.

This project is intentionally narrow in scope and takes its quality bar, split-pane behavior, and documentation tone from [JSConsole](https://jsconsole.schalkneethling.com).

## What It Does

The app provides two panes:

- A CSS editor powered by CodeMirror 6
- An accessible AST tree view powered by `css-tree`
- Selector specificity annotations powered by `@bramus/specificity`

It is designed as a compact browser tool: edit CSS, inspect how it parses, collapse or expand the tree, and keep moving.

## Architecture Choice

This viewer is browser-first by design.

That is the right choice for v1 because:

- `css-tree` supports browser usage directly, so there is no strong technical reason to add a server
- parsing CSS locally is fast enough for immediate feedback
- the stylesheet never needs to leave the user’s machine
- deployment stays simple because the app is just a static frontend
- the product goal is inspection, not privileged execution

For this version, the parser runs on the client, the AST is normalized into a tree-view-friendly model with stable ids, and expansion state is managed separately from the raw parser output.

## Features

- CodeMirror-based CSS editor with a sample stylesheet loaded by default
- `css-tree` parsing in the browser with debounced updates
- Selector specificity badges for selector nodes in the AST explorer
- Accessible AST tree using the WAI-ARIA APG tree view interaction model
- Resizable APG-inspired splitter between the editor and tree panes
- Reset, clear, expand-all, and collapse-all controls
- Responsive layout that keeps both panes usable on smaller screens

## Accessibility Notes

### Splitter

The workspace splitter follows the WAI-ARIA Authoring Practices window splitter pattern:

- It uses `role="separator"`
- It exposes `aria-valuemin`, `aria-valuemax`, and `aria-valuenow`
- It references the editor pane with `aria-controls`
- It supports `Left Arrow`, `Right Arrow`, `Home`, `End`, and `Enter`

Reference: [WAI-ARIA APG Window Splitter Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/)

### AST Tree

The AST explorer follows the WAI-ARIA APG tree view pattern:

- The container uses `role="tree"`
- Each node uses `role="treeitem"`
- Child collections use `role="group"`
- `aria-expanded` is present on parent nodes only
- Focus uses a roving `tabindex`
- The tree supports `Up`, `Down`, `Left`, `Right`, `Home`, `End`, and `Enter`

Reference: [WAI-ARIA APG Tree View Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/)

## Local Development

### Requirements

- Node.js
- `pnpm`

### Install

```bash
pnpm install
```

### Start the dev server

```bash
pnpm dev
```

### Build for production

```bash
pnpm build
```

## Project Structure

```text
.
├── src/
│   ├── main.ts
│   └── style.css
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Implementation Notes

- The app is intentionally framework-free and uses direct DOM composition with TypeScript.
- Parsing runs in the browser and is debounced to keep editing responsive.
- Specificity annotations are calculated from the original `css-tree` selector AST via `@bramus/specificity`, so selector badges stay aligned with modern selector rules such as `:is()` and `:not()`.
- The raw `css-tree` AST is normalized into a tree view model with stable ids so the accessibility logic is not coupled directly to parser-specific list objects.
- When parsing fails, the tree surface clearly reports the parser error instead of silently failing.

## Current Limitations

- Large stylesheets may produce very dense trees; typeahead and virtualized rendering would be good follow-ups if the tool grows.
- The current tree model focuses on readability over complete raw-object fidelity for every scalar field.

## License

Licensed under the [MIT License](LICENSE).
