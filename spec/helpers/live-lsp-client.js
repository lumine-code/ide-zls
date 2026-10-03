const childProcess = require("child_process");
const path = require("path");
const { pathToFileURL } = require("url");
const {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} = require("vscode-jsonrpc/node");

const withTimeout = (promise, label, timeout = 10000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
};

class LiveLspClient {
  constructor(adapter, rootPath) {
    this.adapter = adapter;
    this.rootPath = rootPath;
    this.notifications = [];
    this.stderr = "";
    this.registrations = [];
    this.serverRequests = [];
    this.documentVersions = new Map();
    this.sentRequests = [];
  }

  async start(managedServer) {
    const launch = await this.adapter.resolveServer({ rootPath: this.rootPath, managedServer });
    this.launch = launch;
    this.child = childProcess.spawn(launch.command, launch.args || [], {
      cwd: launch.cwd || this.rootPath,
      env: { ...process.env, ...(launch.env || {}) },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk.toString()));
    this.connection = createMessageConnection(
      new StreamMessageReader(this.child.stdout),
      new StreamMessageWriter(this.child.stdin),
      {
        error: (message) => (this.stderr += `${message}\n`),
        warn: (message) => (this.stderr += `${message}\n`),
        info() {},
        log() {},
      },
    );
    this.connection.onNotification((method, params) => this.notifications.push({ method, params }));
    this.connection.onRequest("workspace/configuration", ({ items }) =>
      Promise.all(
        items.map(({ section, scopeUri }) =>
          this.adapter.getWorkspaceConfiguration?.(section, scopeUri),
        ),
      ),
    );
    this.connection.onRequest("workspace/applyEdit", () => ({ applied: true }));
    this.connection.onRequest("workspace/workspaceFolders", () => this.workspaceFolders);
    this.connection.onRequest("client/registerCapability", ({ registrations }) => {
      this.registrations.push(...registrations);
      return null;
    });
    this.connection.onRequest("window/showDocument", (params) => {
      this.serverRequests.push({ method: "window/showDocument", params });
      return { success: true };
    });
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.child.once("exit", () => this.connection?.dispose());
    this.child.once("error", (error) => {
      this.stderr += error.message;
      this.connection?.dispose();
    });
    this.connection.listen();

    const rootUri = pathToFileURL(this.rootPath).href;
    this.workspaceFolders = [{ uri: rootUri, name: path.basename(this.rootPath) }];
    const result = await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "Lumine adapter integration specs", version: "1.0.0" },
      rootUri,
      initializationOptions: await this.adapter.getInitializationOptions?.({
        rootPath: this.rootPath,
        rootUri,
      }),
      workspaceFolders: this.workspaceFolders,
      capabilities: {
        workspace: { applyEdit: true, configuration: true, workspaceFolders: true },
        textDocument: {
          signatureHelp: {
            signatureInformation: { parameterInformation: { labelOffsetSupport: true } },
          },
          synchronization: { dynamicRegistration: false, didSave: true },
          publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
          completion: {
            dynamicRegistration: true,
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["markdown", "plaintext"],
            },
          },
          hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: true, linkSupport: true },
          references: { dynamicRegistration: true },
          documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
          formatting: { dynamicRegistration: true },
          rename: { dynamicRegistration: true, prepareSupport: true },
          inlayHint: { dynamicRegistration: true },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: ["quickfix", "refactor", "source"] },
            },
            resolveSupport: { properties: ["edit"] },
          },
          semanticTokens: {
            requests: { full: true, range: true },
            tokenTypes: [
              "namespace",
              "type",
              "class",
              "struct",
              "function",
              "method",
              "parameter",
              "variable",
              "property",
              "enumMember",
              "macro",
              "keyword",
              "comment",
              "string",
              "number",
              "operator",
            ],
            tokenModifiers: [
              "declaration",
              "definition",
              "readonly",
              "static",
              "deprecated",
              "abstract",
              "async",
              "modification",
              "documentation",
              "defaultLibrary",
            ],
            formats: ["relative"],
            overlappingTokenSupport: false,
            multilineTokenSupport: false,
          },
          callHierarchy: { dynamicRegistration: false },
          typeHierarchy: { dynamicRegistration: true },
          foldingRange: { lineFoldingOnly: true },
          selectionRange: { dynamicRegistration: false },
          documentLink: { dynamicRegistration: false },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
        },
        window: { workDoneProgress: true, showDocument: { support: true } },
        general: { positionEncodings: ["utf-16"] },
      },
    });
    this.capabilities = result.capabilities;
    this.serverInfo = result.serverInfo;
    this.connection.sendNotification("initialized", {});
    this.connection.sendNotification("workspace/didChangeConfiguration", {
      settings: (await this.adapter.getSettings?.()) || {},
    });
    return result;
  }

  async request(method, params, timeout) {
    const options = typeof timeout === "object" ? timeout : {};
    timeout = typeof timeout === "number" ? timeout : undefined;
    if (method === "textDocument/rename" && this.adapter.resolveRenameTarget) {
      const target = await this.adapter.resolveRenameTarget(
        { uri: params.textDocument.uri, position: params.position },
        { session: this, signal: options.signal },
      );
      if (target === null) return null;
      if (target)
        params = { ...params, textDocument: { uri: target.uri }, position: target.position };
    }
    this.sentRequests.push({ method, params });
    return withTimeout(
      this.connection.sendRequest(method, params),
      `${this.adapter.displayName} ${method}; stderr: ${this.stderr}`,
      timeout,
    );
  }

  open(uri, languageId, text) {
    this.documentVersions.set(uri, 1);
    this.connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }
  canExecuteCommand(command) {
    return (this.capabilities.executeCommandProvider?.commands || []).includes(command);
  }

  change(uri, text, version) {
    version ??= (this.documentVersions.get(uri) || 1) + 1;
    this.documentVersions.set(uri, version);
    this.connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  messages(method) {
    return this.notifications.filter((message) => message.method === method);
  }

  async waitFor(check, label, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${label} timed out; stderr: ${this.stderr}`);
  }

  async stop() {
    if (!this.connection) return;
    const exited = new Promise((resolve) => {
      if (this.child.exitCode !== null) resolve();
      else this.child.once("exit", resolve);
    });
    try {
      await withTimeout(this.connection.sendRequest("shutdown"), "shutdown", 2500);
      this.connection.sendNotification("exit");
    } catch {
      this.child?.kill();
    }
    const timer = setTimeout(() => this.child.kill(), 2500);
    await withTimeout(exited, "server process exit", 5000);
    clearTimeout(timer);
    this.connection.dispose();
    this.connection = null;
  }
}

exports.LiveLspClient = LiveLspClient;
exports.fileUri = (filePath) => pathToFileURL(filePath).href;
