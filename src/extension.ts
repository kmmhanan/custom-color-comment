import * as vscode from "vscode";
import * as path from "path";
import { COMMENT_FILE_GLOB, commentTokensForLanguage } from "./languages";

type ErrorColor = "blue" | "yellow" | "red";

interface TagStyle {
  color?: string;
  backgroundColor?: string;
  backgroundOpacity?: number;
  bold?: boolean;
  italic?: boolean;
  lineThrough?: boolean;
  opacity?: number; // 0 - 1
  error?: boolean | ErrorColor;
  errorColor?: ErrorColor;
  errorWarning?: boolean;
}

type TagValue = string | TagStyle;

// Built-in defaults. Users override/extend these via ccComment.tags in settings.json.
// The symbol tags mirror the well-known "Colorful Comments" defaults. The
// named tags below also create native diagnostics in the Problems panel. Note: the original extension
// also ships a plain "//" fallback (grey + strikethrough on ANY untagged
// comment) — intentionally left out here so normal comments keep their
// default editor color. Add it back yourself if you want that look:
// '//': { color: '#474747', lineThrough: true }
const DEFAULT_TAGS: Record<string, TagValue> = {
  "!": "#FF2D00",
  "?": "#00FFFF",
  "^": "#EAF622",
  "*": "#28FF00",
  "&": "#FF06A0",
  "~": "#BE00FF",
  TODO: {
    color: "#00AEEF",
    error: true,
    errorColor: "blue",
    errorWarning: true,
  },

  // --- extras ---
  NOTE: "#00BCD4",
  HACK: "#E91E63",
  "////": { color: "#888888", lineThrough: true, opacity: 0.9 },
  WARN: {
    color: "#FFD700",
    backgroundColor: "#332200",
    italic: true,
    error: true,
    errorColor: "yellow",
    errorWarning: true,
  },
  BUG: {
    color: "#FF3B3B",
    bold: true,
    error: true,
    errorColor: "red",
    errorWarning: true,
  },
};

const decorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
let tagRegexes: { tag: string; regex: RegExp }[] = [];
const tagStyles: Map<string, TagStyle> = new Map();
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let diagnosticCollection: vscode.DiagnosticCollection | undefined;
const warningDiagnostics = new Map<
  string,
  { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }
>();
let warningTreeProvider: WarningTreeProvider | undefined;
let warningTreeView: vscode.TreeView<WarningTreeNode> | undefined;
let isWorkspaceScanRunning = false;
let workspaceRefreshPromise: Promise<void> | undefined;
let workspaceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let ignoreWarningPatterns: string[] = [];
let ignoreAggressivePatterns: string[] = [];
const REFRESH_COMMAND = "customColorComment.refreshDiagnostics";
const WARNING_VIEW_ID = "customColorComment.warnings";
const WORKSPACE_SCAN_EXCLUDE_GLOB = "**/{.git,node_modules,out,dist,build}/**";
const WORKSPACE_SCAN_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "build",
]);
const PROJECT_EXCLUSION_PROFILES = [
  {
    name: "flutter",
    markerGlob: "**/pubspec.yaml",
    directories: [
      ".packages",
      ".dart_tool",
      "Pods",
      "android",
      "ios",
      "macos",
      "windows",
      "linux",
    ],
  },
  {
    name: "node",
    markerGlob: "**/package.json",
    directories: [".next", ".turbo", "coverage"],
  },
  {
    name: "python",
    markerGlob: "**/{pyproject.toml,setup.py,requirements.txt}",
    directories: [
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      ".ruff_cache",
      ".venv",
      "venv",
    ],
  },
  {
    name: "rust",
    markerGlob: "**/Cargo.toml",
    directories: ["target"],
  },
  {
    name: "go",
    markerGlob: "**/go.mod",
    directories: ["vendor"],
  },
  {
    name: "java",
    markerGlob: "**/{pom.xml,build.gradle,build.gradle.kts}",
    directories: [".gradle", "target"],
  },
  {
    name: "dotnet",
    markerGlob: "**/*.{csproj,sln}",
    directories: ["bin", "obj"],
  },
  {
    name: "swift",
    markerGlob: "**/Package.swift",
    directories: [".build"],
  },
] as const;
let detectedProjectExclusions: Array<{
  root: string;
  directories: Set<string>;
}> = [];

type WarningTreeNode =
  | { kind: "tag"; tag: string; diagnostics: vscode.Diagnostic[] }
  | {
      kind: "diagnostic";
      uri: vscode.Uri;
      diagnostic: vscode.Diagnostic;
    };

class WarningTreeProvider implements vscode.TreeDataProvider<WarningTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<
    WarningTreeNode | undefined
  >();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  refresh(): void {
    updateWarningTreeBadge();
    this.changeEmitter.fire(undefined);
  }

  private getDiagnosticEntries(): Array<
    [vscode.Uri, readonly vscode.Diagnostic[]]
  > {
    return Array.from(warningDiagnostics.values(), ({ uri, diagnostics }) => [
      uri,
      diagnostics,
    ]);
  }

  getTreeItem(element: WarningTreeNode): vscode.TreeItem {
    if (element.kind === "tag") {
      const item = new vscode.TreeItem(
        `${element.tag} (${element.diagnostics.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      const severity = element.diagnostics[0]?.severity;
      item.iconPath =
        severity === vscode.DiagnosticSeverity.Error
          ? new vscode.ThemeIcon("error")
          : severity === vscode.DiagnosticSeverity.Information
            ? new vscode.ThemeIcon("info")
            : new vscode.ThemeIcon("warning");
      item.contextValue = "ccCommentTag";
      return item;
    }

    const { uri, diagnostic } = element;
    const item = new vscode.TreeItem(
      diagnostic.message,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = `${vscode.workspace.asRelativePath(uri, false)}:${diagnostic.range.start.line + 1}`;
    item.tooltip = `${uri.fsPath}:${diagnostic.range.start.line + 1}`;
    item.resourceUri = uri;
    item.contextValue = "ccCommentWarning";
    item.command = {
      command: "vscode.open",
      title: "Open Warning",
      arguments: [
        uri,
        {
          selection: diagnostic.range,
          preview: true,
        } satisfies vscode.TextDocumentShowOptions,
      ],
    };
    return item;
  }

  getChildren(element?: WarningTreeNode): WarningTreeNode[] {
    if (element?.kind === "diagnostic") return [];
    if (element?.kind === "tag") {
      const entries = this.getDiagnosticEntries();
      return entries
        .flatMap(([uri, diagnostics]) =>
          diagnostics
            .filter((diagnostic) => diagnostic.code === element.tag)
            .map((diagnostic) => ({
              kind: "diagnostic" as const,
              uri,
              diagnostic,
            })),
        )
        .sort((a, b) => a.uri.toString().localeCompare(b.uri.toString()));
    }

    const byTag = new Map<string, vscode.Diagnostic[]>();
    for (const [, diagnostics] of this.getDiagnosticEntries()) {
      for (const diagnostic of diagnostics) {
        const diagnosticCode = diagnostic.code;
        const tag =
          typeof diagnosticCode === "string"
            ? diagnosticCode
            : typeof diagnosticCode === "object"
              ? diagnosticCode.value
              : undefined;
        if (typeof tag !== "string") continue;
        const taggedDiagnostics = byTag.get(tag) ?? [];
        taggedDiagnostics.push(diagnostic);
        byTag.set(tag, taggedDiagnostics);
      }
    }

    const severityOrder = (severity: vscode.DiagnosticSeverity): number => {
      if (severity === vscode.DiagnosticSeverity.Error) return 0;
      if (severity === vscode.DiagnosticSeverity.Information) return 1;
      if (severity === vscode.DiagnosticSeverity.Warning) return 2;
      return 3;
    };

    return [...byTag.entries()]
      .map(([tag, diagnostics]) => ({ kind: "tag" as const, tag, diagnostics }))
      .sort((a, b) => {
        const severityDifference =
          severityOrder(a.diagnostics[0].severity) -
          severityOrder(b.diagnostics[0].severity);
        return severityDifference || a.tag.localeCompare(b.tag);
      });
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function colorWithOpacity(color: string, opacity: number): string {
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const channels =
      hex.length === 3
        ? hex.split("").map((channel) => parseInt(channel + channel, 16))
        : [0, 2, 4].map((offset) =>
            parseInt(hex.slice(offset, offset + 2), 16),
          );
    return `rgba(${channels.join(", ")}, ${opacity})`;
  }

  const rgb = color.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*([\d.]+))?\s*\)$/i,
  );
  if (rgb) {
    const alpha = rgb[4] === undefined ? opacity : Number(rgb[4]) * opacity;
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  }

  return `color-mix(in srgb, ${color} ${opacity * 100}%, transparent)`;
}

function normaliseErrorStyle(style: TagStyle | undefined): {
  enabled: boolean;
  color: ErrorColor;
  warning: boolean;
} {
  if (!style) {
    return { enabled: false, color: "yellow", warning: false };
  }

  const legacyError = typeof style.error === "string" ? style.error : undefined;
  const enabled = !!style.error || legacyError !== undefined;
  const color = style.errorColor ?? legacyError ?? "yellow";
  const warning = !!style.errorWarning || legacyError !== undefined;

  return { enabled, color, warning };
}

function updateWarningTreeBadge(): void {
  if (!warningTreeView) return;

  const showSideBarCount = vscode.workspace
    .getConfiguration("ccComment")
    .get<boolean>("showSideBarCount", true);
  if (!showSideBarCount) {
    warningTreeView.badge = undefined;
    return;
  }

  let count = 0;
  for (const { diagnostics } of warningDiagnostics.values()) {
    count += diagnostics.length;
  }

  warningTreeView.badge =
    count > 0
      ? {
          value: count,
          tooltip: `${count} Custom Color Comment problem${count === 1 ? "" : "s"}`,
        }
      : undefined;
}

function updateDocumentDiagnostics(
  uri: vscode.Uri,
  diagnostics: vscode.Diagnostic[],
): void {
  warningDiagnostics.set(uri.toString(), { uri, diagnostics });
  if (
    vscode.workspace
      .getConfiguration("ccComment")
      .get<boolean>("showInProblems", true)
  ) {
    diagnosticCollection?.set(uri, diagnostics);
  } else {
    diagnosticCollection?.delete(uri);
  }
}

function deleteDocumentDiagnostics(uri: vscode.Uri): void {
  warningDiagnostics.delete(uri.toString());
  diagnosticCollection?.delete(uri);
}

function syncProblemsVisibility(): void {
  if (!diagnosticCollection) return;

  if (
    !vscode.workspace
      .getConfiguration("ccComment")
      .get<boolean>("showInProblems", true)
  ) {
    diagnosticCollection.clear();
    return;
  }

  for (const { uri, diagnostics } of warningDiagnostics.values()) {
    diagnosticCollection.set(uri, diagnostics);
  }
}

function diagnosticSeverity(
  error: ErrorColor | undefined,
): vscode.DiagnosticSeverity | undefined {
  switch (error) {
    case "blue":
      return vscode.DiagnosticSeverity.Information;
    case "yellow":
      return vscode.DiagnosticSeverity.Warning;
    case "red":
      return vscode.DiagnosticSeverity.Error;
    default:
      return undefined;
  }
}

function diagnosticMessage(tag: string, description: string): string {
  const trimmedDescription = description.trim().replace(/^:\s*/, "");
  return trimmedDescription
    ? `${tag} : ${trimmedDescription}`
    : `${tag} comment`;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
  if (!normalized) return /^(?!)$/;
  const hasGlob = /[*?]/.test(normalized);
  let expression = "^";

  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      index++;
      if (normalized[index + 1] === "/") {
        expression += "(?:.*/)?";
        index++;
      } else {
        expression += ".*";
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }

  if (!hasGlob) expression += "(?:/.*)?";
  expression += "$";
  return new RegExp(expression);
}

function matchesPathPatterns(
  uri: vscode.Uri,
  patterns: readonly string[],
): boolean {
  if (uri.scheme !== "file" || patterns.length === 0) return false;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) return false;

  const relativePath = path
    .relative(workspaceFolder.uri.fsPath, uri.fsPath)
    .split(path.sep)
    .join("/");
  return patterns.some((pattern) => globToRegExp(pattern).test(relativePath));
}

function isExcludedFromWorkspaceScan(uri: vscode.Uri): boolean {
  if (uri.scheme !== "file") return true;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) return false;

  const relativePath = path
    .relative(workspaceFolder.uri.fsPath, uri.fsPath)
    .split(path.sep);
  if (
    relativePath.some((segment) =>
      WORKSPACE_SCAN_EXCLUDED_DIRECTORIES.has(segment),
    )
  ) {
    return true;
  }

  return detectedProjectExclusions.some(({ root, directories }) => {
    const projectRelativePath = path.relative(root, uri.fsPath);
    if (
      projectRelativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(projectRelativePath)
    ) {
      return false;
    }
    const projectSegments = projectRelativePath.split(path.sep);
    return directories.has(projectSegments[0]);
  });
}

function shouldRescanForFile(uri: vscode.Uri): boolean {
  return (
    !isExcludedFromWorkspaceScan(uri) &&
    !matchesPathPatterns(uri, ignoreAggressivePatterns)
  );
}

async function detectProjectExclusions(): Promise<void> {
  const exclude = WORKSPACE_SCAN_EXCLUDE_GLOB;
  const discovered = new Map<string, Set<string>>();
  const markerResults = await Promise.all(
    PROJECT_EXCLUSION_PROFILES.map(async (profile) => ({
      profile,
      uris: await vscode.workspace.findFiles(profile.markerGlob, exclude),
    })),
  );

  for (const { profile, uris } of markerResults) {
    for (const uri of uris) {
      if (
        profile.name === "flutter" &&
        !/sdk:\s*flutter\b/.test(
          Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8"),
        )
      ) {
        continue;
      }

      const root = path.dirname(uri.fsPath);
      const directories = discovered.get(root) ?? new Set<string>();
      for (const directory of profile.directories) {
        directories.add(directory);
      }
      discovered.set(root, directories);
    }
  }

  detectedProjectExclusions = [...discovered.entries()].map(
    ([root, directories]) => ({ root, directories }),
  );
}

// Word-like tags (TODO, FIXME, NOTE...) need a word boundary so "TODOING"
// doesn't falsely match. Symbol tags (!, ?, *, ////) match immediately.
function isWordTag(tag: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(tag);
}

function disposeAllDecorations() {
  for (const d of decorationTypes.values()) {
    d.dispose();
  }
  decorationTypes.clear();
}

function loadConfig() {
  disposeAllDecorations();
  tagRegexes = [];
  tagStyles.clear();

  const config = vscode.workspace.getConfiguration("ccComment");
  const userTags = config.get<Record<string, TagValue>>("tags") || {};
  const disableDefaults = config.get<boolean>("disableDefaultTags") || false;
  ignoreWarningPatterns = config.get<string[]>("ignoreWarning", []);
  ignoreAggressivePatterns = config.get<string[]>("ignoreAggressive", []);

  const tags: Record<string, TagValue> = disableDefaults
    ? { ...userTags }
    : { ...DEFAULT_TAGS, ...userTags };

  // Longer tags first, so "////" is checked before "//", "FIXME" before a
  // hypothetical shorter overlapping tag, etc.
  const orderedTagNames = Object.keys(tags).sort((a, b) => b.length - a.length);

  for (const tag of orderedTagNames) {
    const style = tags[tag];
    if (typeof style === "object" && style) {
      tagStyles.set(tag, style);
    }
    const opts: vscode.DecorationRenderOptions = { isWholeLine: false };

    if (typeof style === "string") {
      opts.color = style;
    } else if (style && typeof style === "object") {
      if (style.color) opts.color = style.color;
      if (style.backgroundColor) {
        opts.backgroundColor =
          typeof style.backgroundOpacity === "number"
            ? colorWithOpacity(
                style.backgroundColor,
                Math.min(1, Math.max(0, style.backgroundOpacity)),
              )
            : style.backgroundColor;
      }
      if (style.bold) opts.fontWeight = "bold";
      if (style.italic) opts.fontStyle = "italic";
      if (style.lineThrough) opts.textDecoration = "line-through";
      if (typeof style.opacity === "number") {
        opts.opacity = String(Math.min(1, Math.max(0, style.opacity)));
      }
    } else {
      continue;
    }

    decorationTypes.set(
      tag,
      vscode.window.createTextEditorDecorationType(opts),
    );

    const escaped = escapeRegex(tag);
    const pattern = isWordTag(tag) ? `${escaped}\\b` : escaped;
    const flags = isWordTag(tag) ? "i" : "";
    tagRegexes.push({ tag, regex: new RegExp(pattern, flags) });
  }
}

function hasDisableErrorsDirective(
  document: vscode.TextDocument,
  tokens: ReturnType<typeof commentTokensForLanguage>,
): boolean {
  if (!tokens || document.lineCount === 0) return false;
  const firstLine = document.lineAt(0).text.trim();
  const directive = "ccComment:disable-errors";

  for (const token of tokens.lineComments) {
    if (
      firstLine.startsWith(token) &&
      firstLine.slice(token.length).trim() === directive
    ) {
      return true;
    }
  }

  for (const block of tokens.blockComments) {
    if (!firstLine.startsWith(block.start)) continue;
    let content = firstLine.slice(block.start.length).trim();
    if (content.endsWith(block.end)) {
      content = content.slice(0, -block.end.length).trim();
    }
    if (content === directive) return true;
  }

  return false;
}

function updateDocument(doc: vscode.TextDocument, editor?: vscode.TextEditor) {
  if (doc.uri.scheme === "git") return;
  if (isExcludedFromWorkspaceScan(doc.uri)) {
    deleteDocumentDiagnostics(doc.uri);
    if (!isWorkspaceScanRunning) warningTreeProvider?.refresh();
    return;
  }

  const tokens = commentTokensForLanguage(doc.languageId);
  if (!tokens) {
    updateDocumentDiagnostics(doc.uri, []);
    if (!isWorkspaceScanRunning) warningTreeProvider?.refresh();
    return;
  }
  const disableErrors = hasDisableErrorsDirective(doc, tokens);
  const ignoreWarnings = matchesPathPatterns(doc.uri, ignoreWarningPatterns);

  const matchesByTag: Map<string, vscode.Range[]> = new Map();
  for (const tag of decorationTypes.keys()) {
    matchesByTag.set(tag, []);
  }
  const diagnostics: vscode.Diagnostic[] = [];

  // --- Single-line comments ---
  for (let i = 0; i < doc.lineCount; i++) {
    const lineText = doc.lineAt(i).text;

    let commentStart = -1;
    let matchedToken = "";
    for (const token of tokens.lineComments) {
      const idx = lineText.indexOf(token);
      if (idx !== -1 && (commentStart === -1 || idx < commentStart)) {
        commentStart = idx;
        matchedToken = token;
      }
    }
    if (commentStart === -1) continue;

    const afterToken = lineText.slice(commentStart + matchedToken.length);
    const trimmedAfter = afterToken.replace(/^\s*/, "");

    let chosenTag: string | undefined;
    let fallbackTag: string | undefined; // a tag equal to the bare comment token, e.g. plain "//"

    for (const { tag, regex } of tagRegexes) {
      if (tag === matchedToken) {
        fallbackTag = tag;
        continue;
      }

      let isMatch: boolean;
      if (
        matchedToken &&
        tag.startsWith(matchedToken) &&
        tag.length > matchedToken.length
      ) {
        isMatch = lineText.startsWith(tag, commentStart);
      } else {
        const m = trimmedAfter.match(regex);
        isMatch = !!m && m.index === 0;
      }

      if (isMatch) {
        chosenTag = tag;
        break;
      }
    }

    const finalTag = chosenTag ?? fallbackTag;
    if (finalTag) {
      const range = new vscode.Range(i, commentStart, i, lineText.length);
      matchesByTag.get(finalTag)!.push(range);

      const style = tagStyles.get(finalTag);
      const errorConfig = normaliseErrorStyle(style);
      if (
        errorConfig.enabled &&
        errorConfig.warning &&
        !disableErrors &&
        !ignoreWarnings
      ) {
        const severity = diagnosticSeverity(errorConfig.color);
        if (severity !== undefined) {
          const matchedTagStart =
            matchedToken &&
            finalTag.startsWith(matchedToken) &&
            finalTag.length > matchedToken.length
              ? commentStart
              : commentStart +
                matchedToken.length +
                (afterToken.length - trimmedAfter.length);

          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(i, matchedTagStart, i, lineText.trimEnd().length),
            diagnosticMessage(
              finalTag,
              lineText.slice(matchedTagStart + finalTag.length),
            ),
            severity,
          );
          diagnostic.source = "Custom Color Comment";
          diagnostic.code = finalTag;
          diagnostics.push(diagnostic);
        }
      }
    }
  }

  // --- Block comments (may span multiple lines) ---
  const text = doc.getText();
  for (const block of tokens.blockComments) {
    let searchFrom = 0;
    while (true) {
      const startIdx = text.indexOf(block.start, searchFrom);
      if (startIdx === -1) break;
      const endIdxRaw = text.indexOf(block.end, startIdx + block.start.length);
      const blockEnd =
        endIdxRaw === -1 ? text.length : endIdxRaw + block.end.length;
      const blockText = text.slice(startIdx, blockEnd);

      const innerLines = blockText.split("\n");
      let runningOffset = startIdx;
      for (let li = 0; li < innerLines.length; li++) {
        const rawLine = innerLines[li];
        const lineStartOffset = runningOffset;
        runningOffset += rawLine.length + 1;

        let content = rawLine;
        let stripPrefixLen = 0;
        if (li === 0) {
          stripPrefixLen = block.start.length;
          content = content.slice(stripPrefixLen);
        }

        const strippedMatch = content.match(/^\s*\*?\s*/);
        const strippedLen = strippedMatch ? strippedMatch[0].length : 0;
        const stripped = content.slice(strippedLen);

        for (const { tag, regex } of tagRegexes) {
          const m = stripped.match(regex);
          if (m && m.index === 0) {
            const from = lineStartOffset + stripPrefixLen + strippedLen;
            const to = lineStartOffset + rawLine.trimEnd().length;
            if (from <= to) {
              const range = new vscode.Range(
                doc.positionAt(from),
                doc.positionAt(Math.min(to, text.length)),
              );
              matchesByTag.get(tag)!.push(range);

              const errorConfig = normaliseErrorStyle(tagStyles.get(tag));
              if (
                errorConfig.enabled &&
                errorConfig.warning &&
                !disableErrors &&
                !ignoreWarnings
              ) {
                const severity = diagnosticSeverity(errorConfig.color);
                if (severity !== undefined) {
                  const diagnosticRange = new vscode.Range(
                    doc.positionAt(from),
                    doc.positionAt(Math.min(to, text.length)),
                  );
                  const diagnostic = new vscode.Diagnostic(
                    diagnosticRange,
                    diagnosticMessage(tag, stripped.slice(tag.length)),
                    severity,
                  );
                  diagnostic.source = "Custom Color Comment";
                  diagnostic.code = tag;
                  diagnostics.push(diagnostic);
                }
              }
            }
            break;
          }
        }
      }

      searchFrom = blockEnd;
      if (endIdxRaw === -1) break;
    }
  }

  for (const [tag, ranges] of matchesByTag) {
    const decoType = decorationTypes.get(tag);
    if (decoType && editor?.document === doc) {
      editor.setDecorations(decoType, ranges);
    }
  }

  updateDocumentDiagnostics(doc.uri, diagnostics);
  if (!isWorkspaceScanRunning) warningTreeProvider?.refresh();
}

function scheduleUpdate(editor: vscode.TextEditor | undefined) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (editor) updateDocument(editor.document, editor);
  }, 150);
}

function refreshWorkspaceDiagnostics(): Promise<void> {
  if (workspaceRefreshPromise) return workspaceRefreshPromise;

  workspaceRefreshPromise = runWorkspaceDiagnosticsRefresh().finally(() => {
    workspaceRefreshPromise = undefined;
  });
  return workspaceRefreshPromise;
}

function scheduleWorkspaceDiagnosticsRefresh(): void {
  if (workspaceRefreshTimer) clearTimeout(workspaceRefreshTimer);
  workspaceRefreshTimer = setTimeout(() => {
    workspaceRefreshTimer = undefined;
    void refreshWorkspaceDiagnostics().catch((error: unknown) => {
      console.error("Custom Color Comment file rescan failed:", error);
      void vscode.window.showErrorMessage(
        "Custom Color Comment could not refresh diagnostics after workspace files changed. See the Extension Host log for details.",
      );
    });
  }, 1000);
}

async function runWorkspaceDiagnosticsRefresh(): Promise<void> {
  if (!diagnosticCollection) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Refreshing Custom Color Comment diagnostics",
      cancellable: false,
    },
    async (progress) => {
      isWorkspaceScanRunning = true;
      try {
        await detectProjectExclusions();
        diagnosticCollection?.clear();
        warningDiagnostics.clear();
        warningTreeProvider?.refresh();
        const foundUris = await vscode.workspace.findFiles(
          COMMENT_FILE_GLOB,
          WORKSPACE_SCAN_EXCLUDE_GLOB,
        );
        const uris = foundUris.filter(
          (uri) =>
            !isExcludedFromWorkspaceScan(uri) &&
            !matchesPathPatterns(uri, ignoreAggressivePatterns),
        );
        const documents = new Map<string, vscode.TextDocument>();

        for (const document of vscode.workspace.textDocuments) {
          if (document.uri.scheme !== "git") {
            documents.set(document.uri.toString(), document);
          }
        }

        let failedCount = 0;
        const batchSize = 32;
        for (let start = 0; start < uris.length; start += batchSize) {
          const batch = uris.slice(start, start + batchSize);
          const results = await Promise.allSettled(
            batch.map((uri) => vscode.workspace.openTextDocument(uri)),
          );

          for (let index = 0; index < results.length; index++) {
            const result = results[index];
            if (result.status === "fulfilled") {
              documents.set(result.value.uri.toString(), result.value);
            } else {
              failedCount++;
              console.error(
                `Custom Color Comment could not open ${batch[index].toString()}:`,
                result.reason,
              );
            }
          }

          progress.report({
            message: `${Math.min(start + batch.length, uris.length)} / ${uris.length} files`,
            increment: uris.length
              ? (batch.length / uris.length) * 100
              : undefined,
          });
        }

        const activeEditor = vscode.window.activeTextEditor;
        for (const document of documents.values()) {
          updateDocument(
            document,
            activeEditor?.document === document ? activeEditor : undefined,
          );
        }

        if (failedCount > 0) {
          void vscode.window.showWarningMessage(
            `Custom Color Comment could not scan ${failedCount} workspace file(s). See the Extension Host log for details.`,
          );
        }
      } finally {
        isWorkspaceScanRunning = false;
        warningTreeProvider?.refresh();
      }
    },
  );
}

export function activate(context: vscode.ExtensionContext) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection(
    "custom-color-comment",
  );
  context.subscriptions.push(diagnosticCollection);
  warningTreeProvider = new WarningTreeProvider();
  warningTreeView = vscode.window.createTreeView(WARNING_VIEW_ID, {
    treeDataProvider: warningTreeProvider,
  });
  context.subscriptions.push(warningTreeView);
  loadConfig();
  context.subscriptions.push(
    vscode.commands.registerCommand(REFRESH_COMMAND, async () => {
      try {
        await refreshWorkspaceDiagnostics();
        void vscode.window.showInformationMessage(
          "Custom Color Comment diagnostics refreshed.",
        );
      } catch (error) {
        console.error("Custom Color Comment refresh failed:", error);
        void vscode.window.showErrorMessage(
          "Custom Color Comment could not refresh workspace diagnostics. See the Extension Host log for details.",
        );
      }
    }),
  );
  const refreshStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  refreshStatusBar.name = "ccComment: Refresh Warnings";
  refreshStatusBar.text = "$(refresh)";
  refreshStatusBar.tooltip = "ccComment: Refresh Warnings";
  refreshStatusBar.command = REFRESH_COMMAND;
  refreshStatusBar.show();
  context.subscriptions.push(refreshStatusBar);

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, COMMENT_FILE_GLOB),
    );
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate((uri) => {
        if (shouldRescanForFile(uri)) {
          scheduleWorkspaceDiagnosticsRefresh();
        }
      }),
      watcher.onDidDelete((uri) => {
        deleteDocumentDiagnostics(uri);
        warningTreeProvider?.refresh();
      }),
    );
  }

  void refreshWorkspaceDiagnostics().catch((error: unknown) => {
    console.error("Custom Color Comment initial scan failed:", error);
    void vscode.window.showErrorMessage(
      "Custom Color Comment could not scan workspace diagnostics. See the Extension Host log for details.",
    );
  });

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      scheduleUpdate(editor),
    ),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && e.document === editor.document) {
        scheduleUpdate(editor);
      } else {
        updateDocument(e.document);
      }
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      updateDocument(document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (
        document.uri.scheme !== "file" ||
        matchesPathPatterns(document.uri, ignoreAggressivePatterns)
      ) {
        deleteDocumentDiagnostics(document.uri);
        warningTreeProvider?.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ccComment")) {
        loadConfig();
        syncProblemsVisibility();
        updateWarningTreeBadge();
        void refreshWorkspaceDiagnostics().catch((error: unknown) => {
          console.error(
            "Custom Color Comment configuration rescan failed:",
            error,
          );
          void vscode.window.showErrorMessage(
            "Custom Color Comment could not refresh diagnostics after a settings change. See the Extension Host log for details.",
          );
        });
      }
    }),
  );
}

export function deactivate() {
  if (workspaceRefreshTimer) clearTimeout(workspaceRefreshTimer);
  disposeAllDecorations();
  diagnosticCollection?.dispose();
  diagnosticCollection = undefined;
  warningDiagnostics.clear();
  warningTreeView = undefined;
  warningTreeProvider = undefined;
}
