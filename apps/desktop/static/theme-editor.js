// The theme editor's text area, as VS Code's own editor (Monaco).
//
// Loaded the first time a theme is edited: Monaco is a few megabytes, and most
// sessions never open it. It comes as a prebuilt AMD bundle (scripts/vendor.mjs
// copies it into ./vendor/monaco), which needs no bundler — a loader script
// defines `require`, and the editor arrives through it.
//
// What it adds over a plain text box: the theme schema drives autocomplete of
// setting names, a description on hover and a red underline under a bad
// value; every colour gets a swatch that opens a picker; and in a template,
// the building blocks, the template attributes and the {{ … | filters }}
// complete with their descriptions.

const BASE = new URL("./vendor/monaco/vs", import.meta.url).href;

let loading = null;

function loadMonaco() {
  loading ??= new Promise((resolve, reject) => {
    // The JSON language runs in a worker. Pointed straight at the worker file:
    // the page's CSP has no room for the data: URL Monaco would otherwise make.
    window.MonacoEnvironment = { getWorkerUrl: () => `${BASE}/base/worker/workerMain.js` };
    const script = document.createElement("script");
    script.src = `${BASE}/loader.js`;
    script.onerror = () => reject(new Error("the editor could not be loaded"));
    script.onload = () => {
      window.require.config({ paths: { vs: BASE } });
      window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
    };
    document.head.append(script);
  });
  return loading;
}

// -- Colours ---------------------------------------------------------------------
// Monaco's own JSON colour support only knows "#rrggbb". Themes also use
// rgba(), so both are found here and both get a swatch and a picker.

const COLOUR = /"(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.\s,%]+\))"/g;

function parseColour(text) {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex !== null) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { red: n(0), green: n(2), blue: n(4), alpha: h.length === 8 ? n(6) : 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text);
  if (rgb === null) return null;
  return {
    red: Math.min(255, Number(rgb[1])) / 255,
    green: Math.min(255, Number(rgb[2])) / 255,
    blue: Math.min(255, Number(rgb[3])) / 255,
    alpha: rgb[4] === undefined ? 1 : Math.min(1, Number(rgb[4])),
  };
}

function formatColour(c) {
  const b = (v) => Math.round(v * 255);
  if (c.alpha >= 0.995) return `#${[c.red, c.green, c.blue].map((v) => b(v).toString(16).padStart(2, "0")).join("")}`;
  return `rgba(${b(c.red)}, ${b(c.green)}, ${b(c.blue)}, ${Number(c.alpha.toFixed(2))})`;
}

function registerColours(monaco) {
  monaco.languages.registerColorProvider("json", {
    provideDocumentColors(model) {
      const out = [];
      for (let line = 1; line <= model.getLineCount(); line++) {
        const text = model.getLineContent(line);
        for (const m of text.matchAll(COLOUR)) {
          const color = parseColour(m[1]);
          if (color === null) continue;
          // The value without its quotes.
          const start = m.index + 2;
          out.push({ color, range: new monaco.Range(line, start, line, start + m[1].length) });
        }
      }
      return out;
    },
    provideColorPresentations: (_model, info) => [{ label: formatColour(info.color) }],
  });
}

// -- Templates -------------------------------------------------------------------
// HTML with Exxeed's own tags and attributes: the building blocks (x-map…) and
// data-if / data-each / data-class, described where the editor can show them.

const DIRECTIVES = [
  { name: "data-if", description: 'Only while the value is truthy: data-if="isPlayer", or data-if="!isPlayer".' },
  { name: "data-each", description: 'Once per item of a list: data-each="rows", or data-each="r in rows". Inside, names look in the item first; {{ . }} is the item itself; $index, $first, $last and $count are set.' },
  { name: "data-class", description: 'Classes switched on by values: data-class="me: isPlayer; pit: onPitRoad".' },
  { name: "data-part", description: "Hidden when the driver switches this part off in the overlay's options (its id, as the built-in template uses)." },
];

function registerTemplates(monaco, blocks, filters) {
  monaco.languages.html.htmlDefaults.setOptions({
    ...monaco.languages.html.htmlDefaults.options,
    data: {
      useDefaultDataProvider: true,
      dataProviders: {
        exxeed: {
          version: 1.1,
          tags: [
            { name: "x-group", description: "Takes no room of its own: wraps siblings to repeat or hide them together.", attributes: [] },
            ...blocks.map((b) => ({
              name: b.tag,
              description: b.summary,
              attributes: Object.entries(b.attributes ?? {}).map(([name, description]) => ({ name, description })),
            })),
          ],
          globalAttributes: DIRECTIVES,
        },
      },
    },
  });
  // After a "|" inside {{ }}: the filters.
  monaco.languages.registerCompletionItemProvider("html", {
    triggerCharacters: ["|"],
    provideCompletionItems(model, position) {
      const before = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      if (!/\{\{[^}]*\|\s*\w*$/.test(before)) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return {
        suggestions: Object.keys(filters).map((name) => ({
          label: name,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: name,
          range,
        })),
      };
    },
  });
}

const LANGUAGE = (file) => (file.endsWith(".css") ? "css" : file.endsWith(".html") ? "html" : "json");

/**
 * Put an editor in `host`. Resolves to a small handle: open a file's text,
 * read it back, and be told when it changes. Rejects if Monaco cannot load,
 * and the caller keeps its plain text box.
 *
 * `blocks` and `filters` describe what a template can use (panels/index.js).
 */
export async function createThemeEditor(host, schema, onChange, { blocks = [], filters = {} } = {}) {
  const monaco = await loadMonaco();

  if (!createThemeEditor.configured) {
    createThemeEditor.configured = true;
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: false,
      // The schema is handed over, never fetched: the app has it.
      enableSchemaRequest: false,
      // A theme file names its schema by a relative path, for other editors.
      // Here the schema above is used for every file, so that line is not a problem.
      schemaRequest: "ignore",
      // A theme file names its schema itself: "$schema": "./theme.schema.json".
      // That wins over fileMatch, so the schema is registered at the address
      // that path resolves to from the document's own (the theme.json model).
      schemas: [
        { uri: "exxeed://themes/theme.schema.json", fileMatch: ["*"], schema },
        { uri: "exxeed://theme.schema.json", fileMatch: ["*"], schema },
      ],
    });
    registerColours(monaco);
    registerTemplates(monaco, blocks, filters);
  }

  const editor = monaco.editor.create(host, {
    model: null,
    theme: "vs-dark",
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 12.5,
    tabSize: 2,
    scrollBeyondLastLine: false,
    colorDecorators: true,
    quickSuggestions: { strings: true, other: true, comments: false },
    // Hover cards and the suggestion list may spill past the editor's box, but
    // must stay above the dialog they are in.
    fixedOverflowWidgets: true,
    formatOnPaste: true,
  });

  let muted = false;
  editor.onDidChangeModelContent(() => {
    if (!muted) onChange(editor.getValue());
  });

  /** One model per file, kept while the editor lives, so undo survives switching tabs. */
  const models = new Map();

  return {
    getValue: () => editor.getValue(),
    /** Show `file` with `text` in it. Loading a file is not an edit. */
    open(file, text) {
      let model = models.get(file);
      if (model === undefined) {
        model = monaco.editor.createModel("", LANGUAGE(file), monaco.Uri.parse(`exxeed://themes/${file}`));
        models.set(file, model);
      }
      muted = true;
      if (model.getValue() !== text) model.setValue(text);
      editor.setModel(model);
      muted = false;
      editor.setScrollTop(0);
    },
    /** Forget every file: another theme is being opened. */
    reset() {
      editor.setModel(null);
      for (const m of models.values()) m.dispose();
      models.clear();
    },
    focus: () => editor.focus(),
  };
}
