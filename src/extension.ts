import * as vscode from "vscode";
import { commentTokensForLanguage } from "./languages";

interface TagStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  lineThrough?: boolean;
  opacity?: number; // 0 - 1
}

type TagValue = string | TagStyle;

// Built-in defaults. Users override/extend these via ccComment.tags in settings.json.
// The first 7 mirror the well-known "Colorful Comments" extension's defaults
// (red !, cyan ?, yellow ^, green *, pink &, purple ~, mustard todo). The
// rest are extras on top of that baseline. Note: the original extension
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
  todo: "#FF8C00",

  // --- extras ---
  FIXME: { color: "#FF3B3B", bold: true },
  NOTE: "#00BCD4",
  HACK: "#E91E63",
  "////": { color: "#888888", lineThrough: true, opacity: 0.9 },
};

const decorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
let tagRegexes: { tag: string; regex: RegExp }[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const opts: vscode.DecorationRenderOptions = { isWholeLine: false };

    if (typeof style === "string") {
      opts.color = style;
    } else if (style && typeof style === "object") {
      if (style.color) opts.color = style.color;
      if (style.backgroundColor) opts.backgroundColor = style.backgroundColor;
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

function updateDecorations(editor: vscode.TextEditor | undefined) {
  if (!editor) return;

  const doc = editor.document;
  const tokens = commentTokensForLanguage(doc.languageId);
  if (!tokens) return;

  const matchesByTag: Map<string, vscode.Range[]> = new Map();
  for (const tag of decorationTypes.keys()) matchesByTag.set(tag, []);

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
      // A tag equal to the comment token itself (e.g. "//") is a fallback
      // style for otherwise-untagged comments, not a pattern to match here —
      // it's only applied if nothing more specific matches this line.
      if (tag === matchedToken) {
        fallbackTag = tag;
        continue;
      }

      // Tags that repeat/extend the comment token itself (e.g. "////" on
      // top of a "//" token) must be checked from the true comment start,
      // since the token was already consumed out of trimmedAfter.
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
        break; // first (longest/most specific) matching tag wins
      }
    }

    const finalTag = chosenTag ?? fallbackTag;
    if (finalTag) {
      const range = new vscode.Range(i, commentStart, i, lineText.length);
      matchesByTag.get(finalTag)!.push(range);
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
        runningOffset += rawLine.length + 1; // +1 for the '\n'

        let content = rawLine;
        let stripPrefixLen = 0;
        if (li === 0) {
          stripPrefixLen = block.start.length;
          content = content.slice(stripPrefixLen);
        }

        // Strip common block-continuation decoration, e.g. leading " * "
        const strippedMatch = content.match(/^\s*\*?\s*/);
        const strippedLen = strippedMatch ? strippedMatch[0].length : 0;
        const stripped = content.slice(strippedLen);

        for (const { tag, regex } of tagRegexes) {
          const m = stripped.match(regex);
          if (m && m.index === 0) {
            const from = lineStartOffset + stripPrefixLen + strippedLen;
            const to = lineStartOffset + rawLine.length;
            if (from <= to) {
              const range = new vscode.Range(
                doc.positionAt(from),
                doc.positionAt(Math.min(to, text.length)),
              );
              matchesByTag.get(tag)!.push(range);
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
    if (decoType) editor.setDecorations(decoType, ranges);
  }
}

function scheduleUpdate(editor: vscode.TextEditor | undefined) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => updateDecorations(editor), 150);
}

export function activate(context: vscode.ExtensionContext) {
  loadConfig();
  scheduleUpdate(vscode.window.activeTextEditor);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      scheduleUpdate(editor),
    ),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && e.document === editor.document) scheduleUpdate(editor);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ccComment")) {
        loadConfig();
        scheduleUpdate(vscode.window.activeTextEditor);
      }
    }),
  );
}

export function deactivate() {
  disposeAllDecorations();
}
