const { Point } = require("lumine");
const { pathToFileURL } = require("node:url");
const { createProject, removeProject, position, uriKey } = require("./helpers/project");
const serverPath = process.env.ZLS_PATH || require("./helpers/server-resolver").findOnPath("zls"),
  zigPath = process.env.ZIG_PATH || require("./helpers/server-resolver").findOnPath("zig");
const liveSuite = serverPath && zigPath ? describe : () => {};
const until = async (check, label) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
};
liveSuite("ide-zls actual editor routing", () => {
  let fixture, editor, zonEditor, paths, service, published, subscription, timeout;
  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    fixture = createProject();
    paths = lumine.project.getPaths();
    published = [];
    lumine.config.set("ide-zls.serverPath", serverPath);
    lumine.config.set("ide-zls.zigPath", zigPath);
    for (const name of ["language-zig", "ide-client", "ide-zls"])
      await lumine.packages.activatePackage(name);
    service = lumine.packages.getActivePackage("ide-client").mainModule.provideIdeClient();
    subscription = service.onDidPublishDiagnostics((value) => published.push(value));
    lumine.project.setPaths([fixture.rootPath]);
    editor = await lumine.workspace.open(fixture.filePath);
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.zig"));
  });
  afterEach(async () => {
    subscription.dispose();
    editor?.destroy();
    zonEditor?.destroy();
    for (const name of ["ide-zls", "ide-client", "language-zig"])
      await lumine.packages.deactivatePackage(name);
    for (const key of [
      "serverPath",
      "zigPath",
      "features.format",
      "features.rename",
      "features.hover",
    ])
      lumine.config.unset(`ide-zls.${key}`);
    lumine.project.setPaths(paths);
    await lumine.fileWatchClient.settlePendingTeardown();
    await removeProject(fixture.rootPath);
    zonEditor = null;
  });
  const point = (fragment, inside = 1) => {
    const p = position(fixture.text, fragment, inside);
    return new Point(p.line, p.character);
  };
  const ready = async () => {
    const session = await until(
      async () =>
        (await service.activeSessionsForEditor(editor)).find(
          ({ adapter }) => adapter.id === "ide-zls",
        ),
      "Zig session",
    );
    await until(
      () =>
        published.some(
          ({ uri, diagnostics }) =>
            uriKey(uri) === uriKey(fixture.uri) &&
            diagnostics.some(({ message }) => message.includes("unused local variable")),
        ),
      "Zig AST findings",
    );
    return session;
  };
  const main = () => lumine.packages.getActivePackage("ide-client").mainModule;
  it("routes completion, hover, signature, references, rename, symbols, hints, tokens and formatting", async () => {
    await ready();
    const m = main();
    const suggestions = await m.provideAutocomplete().getSuggestions({
      editor,
      bufferPosition: point("add(3,4)", 2),
      prefix: "ad",
      activatedManually: true,
    });
    expect(
      suggestions.some((item) => (item.displayText || item.text || item.snippet || "") === "add"),
    ).toBe(true);
    expect(
      JSON.stringify(await m.provideContextHelp().getHelp(editor, point("add(3,4)"))),
    ).toContain("Add two numbers.");
    expect(
      (await m.provideHoverSignature().getSignature(editor, point("add(3,4)", 6))).signatures[0]
        .label,
    ).toContain("second: i32");
    expect(
      (await m.provideFindReferences().findReferences(editor, point("add(3,4)"))).references.length,
    ).toBe(3);
    const renamed = await m
      .provideRefactor()
      .rename(editor, point("add(3,4)"), "sum", { dryRun: true });
    const edits = [...renamed.edits].find(
      ([file]) => uriKey(pathToFileURL(file).href) === uriKey(fixture.uri),
    )?.[1];
    expect(edits.length).toBe(3);
    expect(edits.every(({ newText }) => newText === "sum")).toBe(true);
    const call = position(fixture.text, "add(3,4)");
    expect(
      edits.some(({ oldRange }) =>
        Point.fromObject(oldRange.start || oldRange[0]).isEqual([call.line, call.character]),
      ),
    ).toBe(true);
    const documentProvider = m.provideDocumentSymbolProvider();
    const source = documentProvider
      .getDocumentSymbolSources(editor)
      .find(({ id }) => id === "ide-client:ide-zls");
    expect(source.state).toBe("ready");
    const symbols = await documentProvider.getDocumentSymbols(editor, { sourceId: source.id });
    expect(symbols.some(({ name }) => name === "Calculator")).toBe(true);
    expect(
      (
        await m.provideInlayHints().inlayHints(editor, [0, fixture.text.split("\n").length - 2])
      ).some(({ label }) => label === "first:"),
    ).toBe(true);
    expect((await m.provideSemanticTokens().semanticTokens(editor)).length).toBeGreaterThan(0);
    expect((await m.provideCodeFormatFile().formatEntireFile(editor)).length).toBeGreaterThan(0);
  });
  it("applies an actual AST quickfix and honours switches without stopping the server", async () => {
    const session = await ready(),
      m = main(),
      issue = published
        .find(
          ({ uri, diagnostics }) =>
            uriKey(uri) === uriKey(fixture.uri) &&
            diagnostics.some(({ message }) => message.includes("unused local variable")),
        )
        .diagnostics.find(({ message }) => message.includes("unused local variable"));
    const actions = await m.provideIntentionsList().getIntentions({
        textEditor: editor,
        bufferPosition: new Point(issue.range.start.line, issue.range.start.character + 1),
      }),
      discard = actions.find(({ title }) => title === "discard value");
    expect(discard).toBeTruthy();
    await discard.selected();
    expect(editor.getText()).toContain("_ = unused;");
    lumine.config.set("ide-zls.features.format", false);
    expect(await m.provideCodeFormatFile().formatEntireFile(editor)).toBeNull();
    lumine.config.set("ide-zls.features.rename", false);
    expect(await m.provideRefactor().rename(editor, point("add(3,4)"), "sum")).toBeNull();
    lumine.config.set("ide-zls.features.hover", false);
    expect(await m.provideContextHelp().getHelp(editor, point("add(3,4)"))).toBeNull();
    expect(session.state).toBe("running");
  });
  it("formats ZON through the real provider while refusing features the server cannot supply there", async () => {
    const session = await ready();
    zonEditor = await lumine.workspace.open(fixture.zonPath);
    zonEditor.setGrammar(lumine.grammars.grammarForScopeName("source.zig"));
    expect(
      (await main().provideCodeFormatFile().formatEntireFile(zonEditor)).length,
    ).toBeGreaterThan(0);
    expect((await main().provideSemanticTokens().semanticTokens(zonEditor)).length).toBeGreaterThan(
      0,
    );
    for (const [method, feature] of [
      ["textDocument/hover", "hover"],
      ["textDocument/completion", "autocomplete"],
      ["textDocument/rename", "rename"],
      ["textDocument/documentSymbol", "symbols"],
    ])
      expect(await service.activeSessionForFeature(zonEditor, method, feature)).toBeNull();
    expect(service.featureEnabled(session.adapter, "format", zonEditor)).toBe(true);
  });
  it("clears stale AST findings and serves a new package generation after unload", async () => {
    const previous = await ready(),
      before = published.length;
    editor.setText(fixture.text.replace("var unused:i32=3;", ""));
    await until(
      () =>
        published
          .slice(before)
          .some(
            ({ uri, diagnostics }) =>
              uriKey(uri) === uriKey(fixture.uri) && diagnostics.length === 0,
          ),
      "cleared Zig findings",
    );
    const pkg = lumine.packages.getActivePackage("ide-zls"),
      old = pkg.mainModule,
      packagePath = pkg.path;
    await lumine.packages.deactivatePackage("ide-zls");
    await until(() => previous.state === "stopped", "Zig teardown");
    expect(service.adaptersForEditor(editor)).toEqual([]);
    await lumine.packages.unloadPackage("ide-zls");
    await lumine.packages.loadPackage(packagePath);
    expect((await lumine.packages.activatePackage("ide-zls")).mainModule).not.toBe(old);
    const renewed = await until(
      async () =>
        (await service.activeSessionsForEditor(editor)).find(
          ({ adapter }) => adapter.id === "ide-zls",
        ),
      "fresh Zig session",
    );
    expect(renewed).not.toBe(previous);
    const hover = await renewed.request("textDocument/hover", {
      textDocument: { uri: fixture.uri },
      position: position(fixture.text, "add(3,4)", 1),
    });
    expect(JSON.stringify(hover)).toContain("add");
  });
});
