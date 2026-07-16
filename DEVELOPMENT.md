# Development

## Local setup

```bash
npm install
npm run compile
```

Press **F5** (with this folder open in VS Code) to launch an Extension
Development Host with the extension active.

## How it works

- `src/languages.ts` maps each VS Code `languageId` to its line-comment and
  block-comment tokens, with a fallback (`// # -- ; /* */`) for unrecognized
  languages.
- `src/extension.ts` reads `ccComment.tags`, builds one
  `TextEditorDecorationType` per tag, scans the active document for comment
  tokens immediately followed by a configured tag, and decorates the rest of
  that comment (or block-comment line) with the matching style. Decorations
  refresh on edits, editor switches, and configuration changes.

## Publishing to the Marketplace (manual)

No Azure, no Azure DevOps, no card required — just a free Microsoft account.
The GitHub repo can be public or private; it makes no difference here, since
you're uploading a `.vsix` file directly, not publishing through GitHub.

1. **Create a publisher** at
   [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) —
   sign in with a Microsoft account, click **Create publisher**, give it an
   id/name. Set `publisher` in `package.json` to that id.

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
   through a virus/metadata scan (usually a few minutes to ~30 min) and then
   appears live on the Marketplace. The version stays in a "Verifying"
   state until that scan clears.

5. To update later: repeat with a bumped version, then use the pencil/edit
   icon next to the existing extension listing to upload the new `.vsix`.

### Notes on images in the README

The Marketplace fetches `README.md` and resolves any relative image paths
against the git repository set in `package.json`'s `repository.url` field
(via `vsce`'s link rewriting) — this only works if the repo is **public**.
If the repo is private, `raw.githubusercontent.com` can't serve the image to
an unauthenticated request, and it'll silently fail to load even though the
rest of the README renders fine.

If you need to keep the repo private but still want a working image, get a
public CDN URL without making the repo public: open any GitHub repo → New
issue (no need to submit it) → drag the image into the comment box. GitHub
uploads it and gives a permanent public link like
`https://github.com/user-attachments/assets/xxxxxxxx-...`, which works
regardless of the repo's visibility.

### Marketplace badges

Shields.io retired all Visual Studio Marketplace badges (version, installs,
rating) service-wide, since Microsoft has never published a documented
public API for that data. There's currently no live-count badge available
from any third party. The README uses a static badge instead. If you also
publish to [Open VSX](https://open-vsx.org), its badges are on a different,
documented API and still work live.

### When you're ready for automated publishing

Two options once you have a card or want to avoid Azure entirely:

- **Azure-based CI** (PAT or Entra ID/OIDC) — both now effectively require
  an Azure subscription with card verification, due to a recent Microsoft
  policy change.
- **[Open VSX](https://open-vsx.org)** — the registry VSCodium and other VS
  Code forks use. Authenticates via GitHub account only, no Microsoft
  account or card needed at all, and supports free token-based CI
  publishing.
