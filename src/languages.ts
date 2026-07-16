export interface BlockComment {
  start: string;
  end: string;
}

export interface CommentTokens {
  lineComments: string[];
  blockComments: BlockComment[];
}

const SLASH_STYLE: CommentTokens = {
  lineComments: ["//"],
  blockComments: [{ start: "/*", end: "*/" }],
};

const HASH_STYLE: CommentTokens = {
  lineComments: ["#"],
  blockComments: [],
};

const HASH_WITH_TRIPLE_QUOTE: CommentTokens = {
  lineComments: ["#"],
  blockComments: [
    { start: '"""', end: '"""' },
    { start: "'''", end: "'''" },
  ],
};

const DASH_STYLE: CommentTokens = {
  lineComments: ["--"],
  blockComments: [{ start: "--[[", end: "]]" }],
};

const HTML_STYLE: CommentTokens = {
  lineComments: [],
  blockComments: [{ start: "<!--", end: "-->" }],
};

const SEMICOLON_STYLE: CommentTokens = {
  lineComments: [";"],
  blockComments: [],
};

const PERCENT_STYLE: CommentTokens = {
  lineComments: ["%"],
  blockComments: [],
};

const BATCH_STYLE: CommentTokens = {
  lineComments: ["REM", "::"],
  blockComments: [],
};

const languageMap: Record<string, CommentTokens> = {
  javascript: SLASH_STYLE,
  javascriptreact: SLASH_STYLE,
  typescript: SLASH_STYLE,
  typescriptreact: SLASH_STYLE,
  json: { lineComments: [], blockComments: [] },
  jsonc: SLASH_STYLE,
  java: SLASH_STYLE,
  c: SLASH_STYLE,
  cpp: SLASH_STYLE,
  csharp: SLASH_STYLE,
  go: SLASH_STYLE,
  rust: SLASH_STYLE,
  swift: SLASH_STYLE,
  kotlin: SLASH_STYLE,
  scala: SLASH_STYLE,
  dart: SLASH_STYLE,
  groovy: SLASH_STYLE,
  "objective-c": SLASH_STYLE,
  "objective-cpp": SLASH_STYLE,
  php: SLASH_STYLE,
  css: { lineComments: [], blockComments: [{ start: "/*", end: "*/" }] },
  scss: SLASH_STYLE,
  less: SLASH_STYLE,
  shaderlab: SLASH_STYLE,
  glsl: SLASH_STYLE,
  hlsl: SLASH_STYLE,

  python: HASH_WITH_TRIPLE_QUOTE,
  ruby: {
    lineComments: ["#"],
    blockComments: [{ start: "=begin", end: "=end" }],
  },
  shellscript: HASH_STYLE,
  yaml: HASH_STYLE,
  dockerfile: HASH_STYLE,
  toml: HASH_STYLE,
  perl: HASH_STYLE,
  powershell: {
    lineComments: ["#"],
    blockComments: [{ start: "<#", end: "#>" }],
  },
  coffeescript: HASH_STYLE,
  makefile: HASH_STYLE,
  properties: HASH_STYLE,
  r: HASH_STYLE,
  elixir: HASH_STYLE,
  crystal: HASH_STYLE,
  nim: HASH_STYLE,
  julia: HASH_STYLE,

  lua: DASH_STYLE,
  sql: DASH_STYLE,
  haskell: {
    lineComments: ["--"],
    blockComments: [{ start: "{-", end: "-}" }],
  },
  elm: {
    lineComments: ["--"],
    blockComments: [{ start: "{-", end: "-}" }],
  },
  ada: DASH_STYLE,
  applescript: {
    lineComments: ["--"],
    blockComments: [{ start: "(*", end: "*)" }],
  },

  html: HTML_STYLE,
  xml: HTML_STYLE,
  markdown: HTML_STYLE,
  vue: {
    lineComments: ["//"],
    blockComments: [
      { start: "<!--", end: "-->" },
      { start: "/*", end: "*/" },
    ],
  },
  svelte: {
    lineComments: ["//"],
    blockComments: [
      { start: "<!--", end: "-->" },
      { start: "/*", end: "*/" },
    ],
  },

  clojure: SEMICOLON_STYLE,
  lisp: SEMICOLON_STYLE,
  scheme: SEMICOLON_STYLE,
  ini: SEMICOLON_STYLE,
  asm: SEMICOLON_STYLE,

  erlang: PERCENT_STYLE,
  matlab: PERCENT_STYLE,
  latex: PERCENT_STYLE,
  tex: PERCENT_STYLE,

  bat: BATCH_STYLE,
  fsharp: {
    lineComments: ["//"],
    blockComments: [{ start: "(*", end: "*)" }],
  },
  vb: {
    lineComments: ["'"],
    blockComments: [],
  },
  pascal: {
    lineComments: ["//"],
    blockComments: [
      { start: "{", end: "}" },
      { start: "(*", end: "*)" },
    ],
  },
};

// Generic fallback used for unrecognized languageIds so the extension still
// "works for any comment" in the common case of C-like or hash-style files.
const FALLBACK: CommentTokens = {
  lineComments: ["//", "#", "--", ";"],
  blockComments: [{ start: "/*", end: "*/" }],
};

export function commentTokensForLanguage(
  languageId: string,
): CommentTokens | undefined {
  if (languageId in languageMap) {
    return languageMap[languageId];
  }
  return FALLBACK;
}
