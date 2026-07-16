# Custom Color Comment

[![Version](https://img.shields.io/visual-studio-marketplace/v/kmmhanan.custom-color-comment?style=flat-square&color=007ACC&logo=visualstudiocode&logoColor=white&label=Version)](https://marketplace.visualstudio.com/items?itemName=kmmhanan.custom-color-comment)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/kmmhanan.custom-color-comment?style=flat-square&color=007ACC&label=Installs)](https://marketplace.visualstudio.com/items?itemName=kmmhanan.custom-color-comment)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/kmmhanan.custom-color-comment?style=flat-square&color=007ACC&label=Rating)](https://marketplace.visualstudio.com/items?itemName=kmmhanan.custom-color-comment)

**[Install from the VS Code Marketplace →](https://marketplace.visualstudio.com/items?itemName=kmmhanan.custom-color-comment)**

Color comments based on a tag right after the comment marker — `//! red`,
`//? cyan`, `// TODO: orange`, `//// grayed-out strikethrough` — and it works
across virtually any language, not just `//`. Python's `#`, Lua's `--`,
HTML's `<!-- -->`, block comments `/* */`, and more are all handled.

## Preview

![Colorful Comment preview](./resources/sample.png)

## Default tags

Most of these mirror the well-known **Colorful Comments** extension's own
defaults; the rest are extras layered on top.

| Tag     | Style                                 | Source              |
| ------- | ------------------------------------- | ------------------- |
| `!`     | red (`#FF2D00`)                       | Colorful Comments   |
| `?`     | cyan (`#00FFFF`)                      | Colorful Comments\* |
| `^`     | yellow (`#EAF622`)                    | Colorful Comments   |
| `*`     | green (`#28FF00`)                     | Colorful Comments   |
| `&`     | pink (`#FF06A0`)                      | Colorful Comments   |
| `~`     | purple (`#BE00FF`)                    | Colorful Comments   |
| `todo`  | mustard (`#FF8C00`), case-insensitive | Colorful Comments   |
| `FIXME` | red, bold                             | extra               |
| `NOTE`  | cyan (`#00BCD4`)                      | extra               |
| `HACK`  | pink (`#E91E63`)                      | extra               |
| `////`  | gray, line-through, 90% opacity       | extra               |

\* Colorful Comments' original `?` default is blue (`#0076FF`); this fork
uses cyan (`#00FFFF`) instead.

**Note:** plain, untagged `//` comments are intentionally left at your
theme's normal comment color — nothing greys them out by default. (The
original Colorful Comments extension does ship a `//` fallback that greys
out _every_ plain comment; if you want that look, add it yourself:
`"//": { "color": "#474747", "lineThrough": true }`.)

## Custom colors — `settings.json`

Add to your user or workspace `settings.json`:

```json
"ccComment.tags": {
  "!": "#FF0000",
  "?": "#121212",
  "TODO": { "color": "#FFA500", "bold": true },
  "WARN": { "color": "#FFD700", "backgroundColor": "#332200", "italic": true }
}
```

Each value is either a plain hex string, or an object with any of:

| Property          | Type    | Effect                  |
| ----------------- | ------- | ----------------------- |
| `color`           | string  | text color (hex)        |
| `backgroundColor` | string  | background color (hex)  |
| `bold`            | boolean | bold text               |
| `italic`          | boolean | italic text             |
| `lineThrough`     | boolean | strikethrough           |
| `opacity`         | number  | `0`–`1`, fades the text |

- Your entries merge on top of the defaults (yours win on conflicts). Set
  `"ccComment.disableDefaultTags": true` to use only your own tags.
- Letter tags (like `TODO`) match as a whole word, so `TODOING` won't
  falsely trigger.
- Symbol tags (`!`, `?`, `*`) match right after the comment marker, with or
  without a space: `//!` and `// !` both work.
- Tags that repeat the comment marker itself (like `////`) are matched from
  the true start of the comment, so a 4-slash line is only caught by `////`,
  not accidentally by a 2- or 3-slash rule.

In code:

```js
//! Test red color
//? What about this branch?
// TODO: refactor this later
//// this whole block is disabled
```

```python
#! also works here
```

## Local development

```bash
npm install
npm run compile
```

Press **F5** (with this folder open in VS Code) to launch an Extension
Development Host with the extension active.

## Publishing to the Marketplace (manual)

No Azure, no Azure DevOps, no card required — just a free Microsoft account.
Your GitHub repo can be public or private; it makes no difference here,
since you're uploading a `.vsix` file directly, not publishing through
GitHub.

1. **Create a publisher** at
   [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) —
   sign in with a Microsoft account (create a free one at outlook.com if
   needed), click **Create publisher**, give it an id/name. Set `publisher`
   in `package.json` to that id.

2. **Bump `"version"`** in `package.json` for each release (semantic
   versioning, e.g. `0.0.1` → `0.0.2`).

3. **Build the package:**

   ```bash
   npm install
   npm run compile
   npm install -g @vscode/vsce
   vsce package
   ```

   This produces `custom-color-comment-X.Y.Z.vsix` in the project folder.

4. **Upload it:** on your publisher page, click **New extension → Visual
   Studio Code**, drag and drop the `.vsix`, then **Upload**. It goes
   through a quick virus/metadata scan and then appears live on the
   Marketplace.

5. To update later: repeat with a bumped version, then use the pencil/edit
   icon next to the existing extension listing to upload the new `.vsix`.

### When you're ready for automated publishing later

Two options once you have a card or want to avoid Azure entirely:

- **Azure-based CI** (PAT or Entra ID/OIDC) — both now effectively require
  an Azure subscription with card verification, due to a recent Microsoft
  policy change. Ask and I'll wire this back into a GitHub Actions workflow.
- **[Open VSX](https://open-vsx.org)** — the registry VSCodium and other VS
  Code forks use. Authenticates via GitHub account only, no Microsoft
  account or card needed at all, and does support free token-based CI
  publishing. Worth doing even alongside manual VS Marketplace uploads, for
  wider reach — ask and I'll add an `ovsx publish` step to a workflow.

## License

MIT — see [LICENSE](./LICENSE).

## How it works

- `src/languages.ts` maps each VS Code `languageId` to its line-comment and
  block-comment tokens, with a fallback (`// # -- ; /* */`) for unrecognized
  languages.
- `src/extension.ts` reads `ccComment.tags`, builds one
  `TextEditorDecorationType` per tag, scans the active document for comment
  tokens immediately followed by a configured tag, and decorates the rest of
  that comment (or block-comment line) with the matching style. Decorations
  refresh on edits, editor switches, and configuration changes.
