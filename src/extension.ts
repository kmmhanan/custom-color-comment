import * as vscode from "vscode";
import { commentTokensForLanguage } from "./languages";

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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function colorWithOpacity(color: string, opacity: number): string {
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const channels =
      hex.length === 3
        ? hex.split("").map((channel) => parseInt(channel + channel, 16))
        : [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
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

function normaliseErrorStyle(
  style: TagStyle | undefined,
): { enabled: boolean; color: ErrorColor; warning: boolean } {
  if (!style) {
    return { enabled: false, color: "yellow", warning: false };
  }

  const legacyError = typeof style.error === "string" ? style.error : undefined;
  const enabled = !!style.error || legacyError !== undefined;
  const color = style.errorColor ?? legacyError ?? "yellow";
  const warning = !!style.errorWarning || legacyError !== undefined;

  return { enabled, color, warning };
}

function diagnosticSeverity(error: ErrorColor | undefined):
  | vscode.DiagnosticSeverity
  | undefined {
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
  const trimmedDescription = description.trim();
  return trimmedDescription
    ? `${tag}: ${trimmedDescription}`
    : `${tag} comment`;
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

function updateDocument(
  doc: vscode.TextDocument,
  editor?: vscode.TextEditor,
) {
  const tokens = commentTokensForLanguage(doc.languageId);
  if (!tokens) {
    diagnosticCollection?.set(doc.uri, []);
    return;
  }
  const disableErrors = hasDisableErrorsDirective(doc, tokens);

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
      if (errorConfig.enabled && errorConfig.warning && !disableErrors) {
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
            new vscode.Range(
              i,
              matchedTagStart,
              i,
              lineText.trimEnd().length,
            ),
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
              if (errorConfig.enabled && errorConfig.warning && !disableErrors) {
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

  diagnosticCollection?.set(doc.uri, diagnostics);
}

function scheduleUpdate(editor: vscode.TextEditor | undefined) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (editor) updateDocument(editor.document, editor);
  }, 150);
}

export function activate(context: vscode.ExtensionContext) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection(
    "custom-color-comment",
  );
  context.subscriptions.push(diagnosticCollection);
  loadConfig();
  const activeEditor = vscode.window.activeTextEditor;
  for (const document of vscode.workspace.textDocuments) {
    updateDocument(
      document,
      activeEditor?.document === document ? activeEditor : undefined,
    );
  }

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
      diagnosticCollection?.delete(document.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ccComment")) {
        loadConfig();
        const activeEditor = vscode.window.activeTextEditor;
        for (const document of vscode.workspace.textDocuments) {
          updateDocument(
            document,
            activeEditor?.document === document ? activeEditor : undefined,
          );
        }
      }
    }),
  );
}

export function deactivate() {
  disposeAllDecorations();
  diagnosticCollection?.dispose();
  diagnosticCollection = undefined;
}
