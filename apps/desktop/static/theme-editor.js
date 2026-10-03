// The theme editor's text area, as VS Code's own editor (Monaco).
//
// Loaded the first time a theme is edited: Monaco is a few megabytes, and most
// sessions never open it. It comes as a prebuilt AMD bundle (scripts/vendor.mjs
// copies it into ./vendor/monaco), which needs no bundler — a loader script
// defines `require`, and the editor arrives through it.
//
// What it adds over a plain text box: the theme schema drives autocomplete of
// setting names, a description on hover and a red underline under a bad
// value; and every colour gets a swatch that opens a picker.

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

/**
 * Put an editor in `host`. Resolves to a small handle: read and replace the
 * text, and be told when it changes. Rejects if Monaco cannot load, and the
 * caller keeps its plain text box.
 */
export async function createThemeEditor(host, schema, onChange) {
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
      // that path resolves to from the document's own (MODEL_URI below).
      schemas: [{ uri: "exxeed://themes/theme.schema.json", fileMatch: ["*"], schema }],
    });
    registerColours(monaco);
  }

  const editor = monaco.editor.create(host, {
    model: monaco.editor.createModel("", "json", monaco.Uri.parse("exxeed://themes/theme.json")),
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

  return {
    getValue: () => editor.getValue(),
    setValue(text) {
      // Loading a file is not an edit.
      muted = true;
      editor.setValue(text);
      muted = false;
      editor.setScrollTop(0);
    },
    focus: () => editor.focus(),
  };
}
