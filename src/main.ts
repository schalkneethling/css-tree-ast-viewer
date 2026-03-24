import "./style.css";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { css as cssLanguage } from "@codemirror/lang-css";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { parse, toPlainObject } from "css-tree";

type PlainNode = Record<string, unknown> & { type: string };

type TreeNode = {
  id: string;
  label: string;
  relation?: string;
  meta: string[];
  summary?: string;
  children: TreeNode[];
};

type VisibleTreeNode = {
  id: string;
  depth: number;
  parentId?: string;
  node: TreeNode;
};

type ParseState =
  | {
      kind: "empty";
      message: string;
      detail: string;
    }
  | {
      kind: "success";
      message: string;
      detail: string;
    }
  | {
      kind: "error";
      message: string;
      detail: string;
    };

const SPLITTER_DEFAULT = 52;
const SPLITTER_MIN = 0;
const SPLITTER_MAX = 100;
const SPLITTER_STEP = 2;
const SPLITTER_COLLAPSED = 0;
const SPLITTER_MIN_PRIMARY_PX = 320;
const SPLITTER_MIN_SECONDARY_PX = 360;
const PARSE_DEBOUNCE_MS = 180;

const sampleCss = `:root {
  --surface: hsl(42 35% 96%);
  --ink: hsl(218 21% 16%);
  --accent: oklch(67% 0.17 42);
}

@media (width > 48rem) {
  .card-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: clamp(1rem, 2vw, 1.5rem);
  }
}

.card-list > article:is(.featured, .pinned) {
  background: linear-gradient(180deg, white, color-mix(in srgb, white 78%, var(--accent)));
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  padding: 1rem 1.25rem;
}

.card-list > article:hover {
  translate: 0 -2px;
}`;

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Unable to mount app");
}

app.innerHTML = `
  <main class="shell">
    <header class="masthead">
      <p class="masthead-line">
        <span class="eyebrow">CSS Tree AST Viewer</span>
        <span class="masthead-copy">Focused CSS parsing, local and inspectable.</span>
      </p>
    </header>

    <section class="workspace" aria-label="CSS AST explorer workspace">
      <section class="panel editor-panel" id="editor-panel" aria-labelledby="editor-title">
        <div class="panel-header">
          <div>
            <p class="panel-kicker">Editor</p>
            <h2 id="editor-title">Stylesheet input</h2>
          </div>
          <div class="actions">
            <button class="ghost-button" id="clear-button" type="button">Clear</button>
            <button class="primary-button" id="reset-button" type="button">Reset sample</button>
          </div>
        </div>
        <div class="panel-body">
          <div class="editor-meta">
            <span>CodeMirror 6</span>
            <span>CSS mode</span>
            <span>Browser-first parsing</span>
          </div>
          <div id="editor" class="editor-host" aria-label="CSS editor"></div>
        </div>
      </section>

      <div
        id="workspace-splitter"
        class="splitter"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-labelledby="editor-title"
        aria-controls="editor-panel"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow="52"
      >
        <span class="splitter-handle" aria-hidden="true"></span>
      </div>

      <section class="panel tree-panel" aria-labelledby="tree-title">
        <div class="panel-header">
          <div>
            <p class="panel-kicker">Explorer</p>
            <h2 id="tree-title">Accessible AST tree</h2>
          </div>
          <div class="tree-actions">
            <button class="ghost-button" id="expand-button" type="button">Expand all</button>
            <button class="ghost-button" id="collapse-button" type="button">Collapse all</button>
          </div>
        </div>
        <div class="panel-body tree-body">
          <div class="status-strip">
            <div id="parse-status" class="status-pill" role="status" aria-live="polite"></div>
            <p id="tree-stats" class="tree-stats"></p>
          </div>
          <div class="tree-surface">
            <div
              id="ast-tree"
              class="tree-root"
              role="tree"
              aria-labelledby="tree-title"
            ></div>
          </div>
        </div>
      </section>
    </section>
  </main>
`;

const editorHostNode = document.querySelector<HTMLDivElement>("#editor");
const treeRootNode = document.querySelector<HTMLDivElement>("#ast-tree");
const parseStatusNodeRef = document.querySelector<HTMLDivElement>("#parse-status");
const treeStatsNodeRef = document.querySelector<HTMLParagraphElement>("#tree-stats");
const resetButtonNode = document.querySelector<HTMLButtonElement>("#reset-button");
const clearButtonNode = document.querySelector<HTMLButtonElement>("#clear-button");
const expandButtonNode = document.querySelector<HTMLButtonElement>("#expand-button");
const collapseButtonNode = document.querySelector<HTMLButtonElement>("#collapse-button");
const workspaceNode = document.querySelector<HTMLElement>(".workspace");
const splitterNode = document.querySelector<HTMLDivElement>("#workspace-splitter");

if (
  !editorHostNode ||
  !treeRootNode ||
  !parseStatusNodeRef ||
  !treeStatsNodeRef ||
  !resetButtonNode ||
  !clearButtonNode ||
  !expandButtonNode ||
  !collapseButtonNode ||
  !workspaceNode ||
  !splitterNode
) {
  throw new Error("Unable to initialize viewer");
}

const editorHost = editorHostNode;
const treeRoot = treeRootNode;
const parseStatusNode = parseStatusNodeRef;
const treeStatsNode = treeStatsNodeRef;
const resetButton = resetButtonNode;
const clearButton = clearButtonNode;
const expandButton = expandButtonNode;
const collapseButton = collapseButtonNode;
const workspace = workspaceNode;
const splitter = splitterNode;

const customTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--editor-text)",
    backgroundColor: "transparent",
    fontFamily: "var(--mono)",
    fontSize: "14px",
  },
  ".cm-scroller": {
    overflow: "auto",
    lineHeight: "1.6",
    padding: "0.85rem 0",
  },
  ".cm-content": {
    caretColor: "var(--accent-strong)",
    padding: "0 1rem 1.5rem",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--gutter)",
    border: "none",
    paddingRight: "0.4rem",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(138, 177, 160, 0.08)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(112, 132, 118, 0.48) !important",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--accent-strong)",
  },
});

const customHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: "var(--syntax-keyword)", fontWeight: "700" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--syntax-property)" },
  { tag: [tags.variableName, tags.name], color: "var(--syntax-variable)" },
  { tag: [tags.number, tags.unit], color: "var(--syntax-number)" },
  { tag: [tags.string], color: "var(--syntax-string)" },
  { tag: [tags.atom, tags.bool], color: "var(--syntax-constant)" },
  { tag: [tags.comment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [tags.operator], color: "var(--syntax-operator)" },
  { tag: [tags.brace, tags.squareBracket, tags.paren, tags.separator], color: "var(--syntax-punctuation)" },
]);

const editor = new EditorView({
  doc: sampleCss,
  extensions: [
    lineNumbers(),
    highlightActiveLineGutter(),
    drawSelection(),
    history(),
    closeBrackets(),
    autocompletion(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
    highlightActiveLine(),
    cssLanguage(),
    customTheme,
    syntaxHighlighting(customHighlightStyle),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        scheduleParse();
      }
    }),
  ],
  parent: editorHost,
});

editor.contentDOM.setAttribute("spellcheck", "false");
editor.contentDOM.setAttribute("autocorrect", "off");
editor.contentDOM.setAttribute("autocapitalize", "off");
editor.contentDOM.setAttribute("data-gramm", "false");
editor.contentDOM.setAttribute("data-gramm_editor", "false");
editor.contentDOM.setAttribute("data-enable-grammarly", "false");

let treeModel: TreeNode | null = null;
let parseState: ParseState = {
  kind: "empty",
  message: "Editor is empty",
  detail: "Paste a stylesheet to inspect its AST.",
};
let expandedNodeIds = new Set<string>();
let focusedNodeId: string | null = null;
let selectedNodeId: string | null = null;
let parseTimer = 0;
let splitValue = SPLITTER_DEFAULT;
let previousExpandedSplitValue = SPLITTER_DEFAULT;

function slug(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "node";
}

function isPlainNode(value: unknown): value is PlainNode {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && typeof (value as PlainNode).type === "string";
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function formatScalar(value: string | number | boolean | null) {
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 36 ? `${value.slice(0, 33)}...` : value;
  return String(value);
}

function metaEntries(node: PlainNode) {
  const importantKeys = ["name", "property", "value", "unit", "important", "flags", "id"];
  const preferred = importantKeys
    .filter((key) => key in node)
    .map((key) => [key, node[key]] as const);
  const rest = Object.entries(node).filter(([key]) => !importantKeys.includes(key));

  return [...preferred, ...rest]
    .filter(([key, value]) => key !== "type" && key !== "loc" && (isScalar(value) || (Array.isArray(value) && value.every(isScalar))))
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return `${key}: ${value.map((item) => formatScalar(item)).join(", ")}`;
      }

      if (isScalar(value)) {
        return `${key}: ${formatScalar(value)}`;
      }

      return `${key}:`;
    })
    .slice(0, 4);
}

function normalizeNode(node: PlainNode, path: string, relation?: string): TreeNode {
  const children: TreeNode[] = [];

  Object.entries(node).forEach(([key, value]) => {
    if (key === "type" || key === "loc") {
      return;
    }

    if (isPlainNode(value)) {
      children.push(normalizeNode(value, `${path}.${slug(key)}`, key));
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (isPlainNode(entry)) {
          children.push(normalizeNode(entry, `${path}.${slug(key)}-${index}`, key === "children" ? undefined : key));
        }
      });
    }
  });

  const meta = metaEntries(node);
  const summary = children.length > 0 ? `${children.length} child${children.length === 1 ? "" : "ren"}` : meta[0];

  return {
    id: path,
    label: node.type,
    relation,
    meta,
    summary,
    children,
  };
}

function collectExpandableIds(node: TreeNode, result = new Set<string>()) {
  if (node.children.length > 0) {
    result.add(node.id);
    node.children.forEach((child) => collectExpandableIds(child, result));
  }

  return result;
}

function getDefaultExpandedIds(node: TreeNode) {
  const result = new Set<string>();

  if (node.children.length > 0) {
    result.add(node.id);
  }

  const firstChild = node.children[0];

  if (firstChild && firstChild.children.length > 0) {
    result.add(firstChild.id);
  }

  return result;
}

function flattenVisibleNodes(node: TreeNode, depth = 1, parentId?: string, result: VisibleTreeNode[] = []) {
  result.push({ id: node.id, depth, parentId, node });

  if (node.children.length > 0 && expandedNodeIds.has(node.id)) {
    node.children.forEach((child) => flattenVisibleNodes(child, depth + 1, node.id, result));
  }

  return result;
}

function countNodes(node: TreeNode): number {
  return 1 + node.children.reduce((total, child) => total + countNodes(child), 0);
}

function getNodeById(node: TreeNode, id: string): TreeNode | null {
  if (node.id === id) {
    return node;
  }

  for (const child of node.children) {
    const match = getNodeById(child, id);
    if (match) {
      return match;
    }
  }

  return null;
}

function focusTreeItem() {
  if (!focusedNodeId) {
    return;
  }

  const item = treeRoot.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(focusedNodeId)}"]`);
  item?.focus();
}

function renderEmptyTree(title: string, detail: string) {
  treeRoot.innerHTML = `
    <div class="tree-empty">
      <p class="tree-empty-title">${title}</p>
      <p>${detail}</p>
    </div>
  `;
}

function renderTree({ focusActiveItem = false } = {}) {
  parseStatusNode.className = `status-pill status-${parseState.kind}`;
  parseStatusNode.textContent = parseState.message;

  if (!treeModel) {
    treeStatsNode.textContent = parseState.detail;
    renderEmptyTree(parseState.message, parseState.detail);
    return;
  }

  treeStatsNode.textContent = `${countNodes(treeModel)} visible AST nodes available for keyboard navigation. ${parseState.detail}`;
  treeRoot.innerHTML = "";

  const fragment = document.createDocumentFragment();

  const appendIntoParent = (node: TreeNode, depth: number, container: HTMLElement | DocumentFragment, parentId?: string) => {
    const treeItem = document.createElement("div");
    const isExpanded = expandedNodeIds.has(node.id);
    const hasChildren = node.children.length > 0;

    treeItem.className = "tree-item";
    treeItem.id = node.id;
    treeItem.dataset.nodeId = node.id;
    treeItem.dataset.parentId = parentId ?? "";
    treeItem.tabIndex = focusedNodeId === node.id ? 0 : -1;
    treeItem.setAttribute("role", "treeitem");
    treeItem.setAttribute("aria-level", String(depth));
    treeItem.setAttribute("aria-selected", String(selectedNodeId === node.id));
    treeItem.style.setProperty("--tree-depth", String(depth - 1));

    if (hasChildren) {
      treeItem.setAttribute("aria-expanded", String(isExpanded));
    }

    const row = document.createElement("div");
    row.className = "tree-row";

    const expander = document.createElement("span");
    expander.className = `tree-expander${hasChildren ? "" : " tree-expander-leaf"}`;
    expander.dataset.action = "toggle";
    expander.setAttribute("aria-hidden", "true");

    const content = document.createElement("div");
    content.className = "tree-content";

    const title = document.createElement("div");
    title.className = "tree-title";

    if (node.relation) {
      const relationTag = document.createElement("span");
      relationTag.className = "tree-relation";
      relationTag.textContent = node.relation;
      title.append(relationTag);
    }

    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = node.label;
    title.append(label);

    if (node.summary) {
      const summary = document.createElement("span");
      summary.className = "tree-summary";
      summary.textContent = node.summary;
      title.append(summary);
    }

    const meta = document.createElement("div");
    meta.className = "tree-meta";

    node.meta.forEach((entry) => {
      const pill = document.createElement("span");
      pill.className = "tree-meta-pill";
      pill.textContent = entry;
      meta.append(pill);
    });

    content.append(title);

    if (node.meta.length > 0) {
      content.append(meta);
    }

    row.append(expander, content);
    treeItem.append(row);

    if (hasChildren && isExpanded) {
      const group = document.createElement("div");
      group.className = "tree-group";
      group.setAttribute("role", "group");

      node.children.forEach((child) => appendIntoParent(child, depth + 1, group, node.id));
      treeItem.append(group);
    }

    container.append(treeItem);
  };

  appendIntoParent(treeModel, 1, fragment);
  treeRoot.append(fragment);

  if (focusActiveItem) {
    focusTreeItem();
  }
}

function setTreeState(nextTree: TreeNode | null) {
  const previousTree = treeModel;
  const previousExpandedNodeIds = new Set(expandedNodeIds);
  treeModel = nextTree;

  if (!treeModel) {
    focusedNodeId = null;
    selectedNodeId = null;
    expandedNodeIds.clear();
    renderTree();
    return;
  }

  const allExpandableIds = collectExpandableIds(treeModel);
  if (!previousTree) {
    expandedNodeIds = getDefaultExpandedIds(treeModel);
  } else {
    const previousExpandableIds = collectExpandableIds(previousTree);
    const nextExpandedNodeIds = new Set<string>();

    allExpandableIds.forEach((id) => {
      if (!previousExpandableIds.has(id) || previousExpandedNodeIds.has(id)) {
        nextExpandedNodeIds.add(id);
      }
    });

    expandedNodeIds = nextExpandedNodeIds;
  }

  if (!focusedNodeId || !getNodeById(treeModel, focusedNodeId)) {
    focusedNodeId = treeModel.id;
  }

  if (!selectedNodeId || !getNodeById(treeModel, selectedNodeId)) {
    selectedNodeId = treeModel.id;
  }

  renderTree();
}

function parseCss() {
  const source = editor.state.doc.toString();

  if (!source.trim()) {
    parseState = {
      kind: "empty",
      message: "Editor is empty",
      detail: "Paste CSS into the editor to build an AST tree.",
    };
    setTreeState(null);
    return;
  }

  try {
    const ast = parse(source, {
      positions: false,
    });

    const plainAst = toPlainObject(ast) as PlainNode;
    const normalizedTree = normalizeNode(plainAst, "ast-root");

    parseState = {
      kind: "success",
      message: "Parsed locally with css-tree",
      detail: "Tree follows the WAI-ARIA APG tree view interaction model.",
    };

    setTreeState(normalizedTree);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    parseState = {
      kind: "error",
      message: "Unable to parse stylesheet",
      detail: message,
    };

    renderTree();
  }
}

function scheduleParse() {
  window.clearTimeout(parseTimer);
  parseTimer = window.setTimeout(() => {
    parseCss();
  }, PARSE_DEBOUNCE_MS);
}

function updateSplitter(value: number) {
  splitValue = Math.min(SPLITTER_MAX, Math.max(SPLITTER_MIN, value));

  if (splitValue > SPLITTER_COLLAPSED) {
    previousExpandedSplitValue = splitValue;
  }

  workspace.style.setProperty("--split-primary", String(splitValue));
  splitter.setAttribute("aria-valuenow", String(Math.round(splitValue)));
  splitter.setAttribute("aria-valuetext", `${Math.round(splitValue)} percent`);
  workspace.dataset.collapsed = String(splitValue === SPLITTER_COLLAPSED);
}

function clampSplitValue(nextValue: number, { allowCollapse = false } = {}) {
  const workspaceWidth = workspace.clientWidth;
  const splitterWidth = splitter.getBoundingClientRect().width || 14;
  const minPrimaryPercent = (SPLITTER_MIN_PRIMARY_PX / workspaceWidth) * 100;
  const minSecondaryPercent = (SPLITTER_MIN_SECONDARY_PX / workspaceWidth) * 100;
  const minAllowed = allowCollapse ? SPLITTER_COLLAPSED : minPrimaryPercent;
  const maxAllowed = 100 - minSecondaryPercent - (splitterWidth / workspaceWidth) * 100;

  if (workspaceWidth <= SPLITTER_MIN_PRIMARY_PX + SPLITTER_MIN_SECONDARY_PX + splitterWidth) {
    return Math.min(SPLITTER_MAX, Math.max(SPLITTER_MIN, nextValue));
  }

  return Math.min(maxAllowed, Math.max(minAllowed, nextValue));
}

function getSplitValueFromPointer(clientX: number) {
  const rect = workspace.getBoundingClientRect();
  const splitterWidth = splitter.getBoundingClientRect().width || 14;
  const availableWidth = rect.width - splitterWidth;
  const rawValue = ((clientX - rect.left - splitterWidth / 2) / availableWidth) * 100;

  return clampSplitValue(rawValue);
}

function toggleSplitterCollapse() {
  if (splitValue === SPLITTER_COLLAPSED) {
    updateSplitter(clampSplitValue(previousExpandedSplitValue || SPLITTER_DEFAULT));
    return;
  }

  previousExpandedSplitValue = splitValue;
  updateSplitter(SPLITTER_COLLAPSED);
}

function focusNode(nodeId: string, { select = false, forceFocus = false } = {}) {
  focusedNodeId = nodeId;

  if (select) {
    selectedNodeId = nodeId;
  }

  renderTree({ focusActiveItem: forceFocus });
}

function toggleNode(nodeId: string, { focusAfter = false, select = false } = {}) {
  const node = treeModel ? getNodeById(treeModel, nodeId) : null;

  if (!node || node.children.length === 0) {
    if (select) {
      focusNode(nodeId, { select: true, forceFocus: focusAfter });
    }

    return;
  }

  if (expandedNodeIds.has(nodeId)) {
    expandedNodeIds.delete(nodeId);
  } else {
    expandedNodeIds.add(nodeId);
  }

  focusedNodeId = nodeId;

  if (select) {
    selectedNodeId = nodeId;
  }

  renderTree({ focusActiveItem: focusAfter });
}

function visibleNodes() {
  return treeModel ? flattenVisibleNodes(treeModel) : [];
}

treeRoot.addEventListener("click", (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");

  if (!item) {
    return;
  }

  const nodeId = item.dataset.nodeId;

  if (!nodeId) {
    return;
  }

  const clickedToggle = (event.target as HTMLElement).closest("[data-action='toggle']");

  if (clickedToggle) {
    toggleNode(nodeId, { focusAfter: true, select: true });
    return;
  }

  focusNode(nodeId, { select: true, forceFocus: true });
});

treeRoot.addEventListener("dblclick", (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");

  if (!item?.dataset.nodeId) {
    return;
  }

  toggleNode(item.dataset.nodeId, { focusAfter: true, select: true });
});

treeRoot.addEventListener("keydown", (event) => {
  if (!treeModel || !focusedNodeId) {
    return;
  }

  const items = visibleNodes();
  const currentIndex = items.findIndex((item) => item.id === focusedNodeId);

  if (currentIndex === -1) {
    return;
  }

  const currentItem = items[currentIndex];
  const currentNode = currentItem.node;
  const hasChildren = currentNode.children.length > 0;
  const isExpanded = expandedNodeIds.has(currentNode.id);

  switch (event.key) {
    case "ArrowDown": {
      event.preventDefault();
      const nextItem = items[currentIndex + 1];
      if (nextItem) {
        focusNode(nextItem.id, { forceFocus: true });
      }
      break;
    }
    case "ArrowUp": {
      event.preventDefault();
      const previousItem = items[currentIndex - 1];
      if (previousItem) {
        focusNode(previousItem.id, { forceFocus: true });
      }
      break;
    }
    case "Home":
      event.preventDefault();
      focusNode(items[0].id, { forceFocus: true });
      break;
    case "End":
      event.preventDefault();
      focusNode(items[items.length - 1].id, { forceFocus: true });
      break;
    case "ArrowRight":
      event.preventDefault();
      if (hasChildren && !isExpanded) {
        toggleNode(currentNode.id, { focusAfter: true });
        break;
      }

      if (hasChildren && isExpanded) {
        focusNode(currentNode.children[0].id, { forceFocus: true });
      }
      break;
    case "ArrowLeft":
      event.preventDefault();
      if (hasChildren && isExpanded) {
        toggleNode(currentNode.id, { focusAfter: true });
        break;
      }

      if (currentItem.parentId) {
        focusNode(currentItem.parentId, { forceFocus: true });
      }
      break;
    case "Enter":
      event.preventDefault();
      if (hasChildren) {
        toggleNode(currentNode.id, { focusAfter: true, select: true });
      } else {
        focusNode(currentNode.id, { forceFocus: true, select: true });
      }
      break;
    default:
      break;
  }
});

resetButton.addEventListener("click", () => {
  editor.dispatch({
    changes: {
      from: 0,
      to: editor.state.doc.length,
      insert: sampleCss,
    },
  });
});

clearButton.addEventListener("click", () => {
  editor.dispatch({
    changes: {
      from: 0,
      to: editor.state.doc.length,
      insert: "",
    },
  });
});

expandButton.addEventListener("click", () => {
  if (!treeModel) {
    return;
  }

  expandedNodeIds = collectExpandableIds(treeModel);
  renderTree({ focusActiveItem: true });
});

collapseButton.addEventListener("click", () => {
  if (!treeModel) {
    return;
  }

  expandedNodeIds = new Set<string>();
  focusedNodeId = treeModel.id;
  renderTree({ focusActiveItem: true });
});

splitter.addEventListener("pointerdown", (event) => {
  if (window.matchMedia("(max-width: 980px)").matches) {
    return;
  }

  event.preventDefault();
  splitter.focus();
  splitter.setPointerCapture(event.pointerId);

  const moveSplitter = (moveEvent: PointerEvent) => {
    updateSplitter(getSplitValueFromPointer(moveEvent.clientX));
  };

  const stopDragging = () => {
    splitter.removeEventListener("pointermove", moveSplitter);
    splitter.removeEventListener("pointerup", stopDragging);
    splitter.removeEventListener("pointercancel", stopDragging);
  };

  splitter.addEventListener("pointermove", moveSplitter);
  splitter.addEventListener("pointerup", stopDragging);
  splitter.addEventListener("pointercancel", stopDragging);
});

splitter.addEventListener("keydown", (event) => {
  switch (event.key) {
    case "ArrowLeft":
      event.preventDefault();
      updateSplitter(clampSplitValue(splitValue - SPLITTER_STEP));
      break;
    case "ArrowRight":
      event.preventDefault();
      updateSplitter(clampSplitValue(splitValue + SPLITTER_STEP));
      break;
    case "Home":
      event.preventDefault();
      updateSplitter(SPLITTER_COLLAPSED);
      break;
    case "End":
      event.preventDefault();
      updateSplitter(clampSplitValue(SPLITTER_MAX));
      break;
    case "Enter":
      event.preventDefault();
      toggleSplitterCollapse();
      break;
    default:
      break;
  }
});

window.addEventListener("resize", () => {
  if (window.matchMedia("(max-width: 980px)").matches) {
    updateSplitter(SPLITTER_DEFAULT);
    return;
  }

  updateSplitter(clampSplitValue(splitValue, { allowCollapse: splitValue === SPLITTER_COLLAPSED }));
});

updateSplitter(SPLITTER_DEFAULT);
parseCss();
