const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { position, uriKey } = require("./project");
const at = (client, fixture, method, fragment, inside = 1, extra = {}) =>
  client.request(method, {
    textDocument: { uri: fixture.uri },
    position: position(fixture.text, fragment, inside),
    ...extra,
  });
const exerciseServer = async (client, fixture) => {
  const checked = [];
  const check = (label, condition) => {
    assert.ok(condition, `${label} produced no usable result`);
    checked.push(label);
  };
  const document = { textDocument: { uri: fixture.uri } };
  client.open(fixture.uri, "zig", fixture.text);
  const diagnostics = await client.waitFor(
    () =>
      client
        .messages("textDocument/publishDiagnostics")
        .find(
          ({ params }) =>
            uriKey(params.uri) === uriKey(fixture.uri) &&
            params.diagnostics.some(({ message }) => message.includes("unused local variable")),
        )?.params.diagnostics,
    "Zig AST diagnostics",
    30000,
  );
  check(
    "diagnostics",
    diagnostics.some(({ message }) => message.includes("unused local variable")),
  );
  const completion = await at(client, fixture, "textDocument/completion", "add(3,4)", 2),
    item = (completion.items || completion).find(({ label }) => label === "add");
  check("completion", item?.textEdit?.newText.includes("add"));
  check(
    "Unicode completion",
    item.textEdit.range.start.character === position(fixture.text, "add(3,4)").character,
  );
  const hover = await at(client, fixture, "textDocument/hover", "add(3,4)");
  check("hover", JSON.stringify(hover).includes("Add two numbers."));
  check(
    "Unicode hover",
    hover.range.start.character === position(fixture.text, "add(3,4)").character,
  );
  check(
    "signature",
    (
      await at(client, fixture, "textDocument/signatureHelp", "add(3,4)", 6)
    ).signatures[0].label.includes("second: i32"),
  );
  const definitions = await at(client, fixture, "textDocument/definition", "add(3,4)");
  check(
    "definition",
    definitions.some(({ uri, targetUri }) => uriKey(uri || targetUri) === uriKey(fixture.uri)),
  );
  const imported = await at(client, fixture, "textDocument/definition", "math.triple(2)", 7);
  check(
    "cross-file definition",
    imported.some(({ uri, targetUri }) => uriKey(uri || targetUri) === uriKey(fixture.mathUri)),
  );
  const stdDefinition = await at(client, fixture, "textDocument/definition", "expectEqual(", 3);
  check(
    "standard library navigation",
    stdDefinition.some(({ uri, targetUri }) =>
      fileURLToPath(uri || targetUri).includes(`${path.sep}std${path.sep}testing.zig`),
    ),
  );
  const references = await at(client, fixture, "textDocument/references", "add(first", 1, {
    context: { includeDeclaration: true },
  });
  check("references", references.length === 3);
  check(
    "Unicode references",
    references.some(
      ({ range }) =>
        range.start.character === position(fixture.text, "add(3,4)").character &&
        range.start.line === position(fixture.text, "add(3,4)").line,
    ),
  );
  const edit = await at(client, fixture, "textDocument/rename", "add(3,4)", 1, { newName: "sum" });
  const rename = Object.entries(edit.changes)
    .filter(([uri]) => uriKey(uri) === uriKey(fixture.uri))
    .flatMap(([, edits]) => edits);
  check("rename", rename.length === 3 && rename.every(({ newText }) => newText === "sum"));
  check(
    "Unicode rename",
    rename.some(
      ({ range }) =>
        range.start.character === position(fixture.text, "add(3,4)").character &&
        range.start.line === position(fixture.text, "add(3,4)").line,
    ),
  );
  const symbols = await client.request("textDocument/documentSymbol", document);
  check(
    "document symbols",
    symbols.some(
      ({ name, children }) =>
        name === "Calculator" && children.some(({ name }) => name === "result"),
    ),
  );
  check(
    "workspace symbols",
    (await client.request("workspace/symbol", { query: "add" })).some(({ name }) => name === "add"),
  );
  check(
    "format",
    (
      await client.request("textDocument/formatting", {
        ...document,
        options: { tabSize: 4, insertSpaces: true },
      })
    ).length > 0,
  );
  const range = {
    start: { line: 0, character: 0 },
    end: { line: fixture.text.split("\n").length - 1, character: 0 },
  };
  const hints = await client.request("textDocument/inlayHint", { ...document, range });
  check(
    "parameter hints",
    hints.some(({ label }) => label === "first:"),
  );
  check(
    "type hints",
    hints.some(({ label }) => label.includes("type")),
  );
  const tokens = await client.request("textDocument/semanticTokens/full", document);
  check("semantic tokens", tokens.data.length > 0 && tokens.data.length % 5 === 0);
  const ranged = await client.request("textDocument/semanticTokens/range", { ...document, range });
  check("semantic token range", ranged.data.length > 0);
  const issue = diagnostics.find(({ message }) => message.includes("unused local variable")),
    actions = await client.request("textDocument/codeAction", {
      ...document,
      range: issue.range,
      context: { diagnostics },
    });
  check(
    "code actions",
    actions.some(
      ({ title, edit }) =>
        title === "discard value" &&
        Object.values(edit?.changes || {})
          .flat()
          .some(({ newText }) => newText.includes("_ = unused")),
    ),
  );
  check("folding", (await client.request("textDocument/foldingRange", document)).length > 0);
  const selections = await client.request("textDocument/selectionRange", {
    ...document,
    positions: [position(fixture.text, "add(3,4)", 1)],
  });
  check("selection ranges", selections.length === 1 && selections[0].parent);
  client.open(fixture.zonUri, "zig", fixture.zon);
  check(
    "ZON format",
    (
      await client.request("textDocument/formatting", {
        textDocument: { uri: fixture.zonUri },
        options: { tabSize: 4, insertSpaces: true },
      })
    ).length > 0,
  );
  const zonTokens = await client.request("textDocument/semanticTokens/full", {
    textDocument: { uri: fixture.zonUri },
  });
  check("ZON tokens", zonTokens.data.length > 0);
  const before = client.notifications.length;
  client.change(fixture.uri, fixture.text.replace("var unused:i32=3;", ""));
  const clear = await client.waitFor(
    () =>
      client.notifications
        .slice(before)
        .find(
          ({ method, params }) =>
            method === "textDocument/publishDiagnostics" &&
            uriKey(params.uri) === uriKey(fixture.uri) &&
            params.diagnostics.length === 0,
        ),
    "cleared AST diagnostics",
    30000,
  );
  check("diagnostic clear", !!clear);
  // The SDK and local imported module are real resources, not synthetic replies.
  check(
    "SDK resources",
    fs.existsSync(fileURLToPath(stdDefinition[0].targetUri || stdDefinition[0].uri)),
  );
  return checked;
};
module.exports = { exerciseServer, at };
