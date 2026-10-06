const path = require("node:path");
const { LiveLspClient } = require("./helpers/live-lsp-client");
const { createProject, removeProject } = require("./helpers/project");
const { exerciseServer } = require("./helpers/exercise-server");
const serverPath = process.env.ZLS_PATH || require("./helpers/server-resolver").findOnPath("zls"),
  zigPath = process.env.ZIG_PATH || require("./helpers/server-resolver").findOnPath("zig");
if (process.env.REQUIRE_ZLS && (!serverPath || !zigPath))
  throw new Error("CI requires a native ZLS server and matching Zig SDK.");
const liveSuite = serverPath && zigPath ? describe : () => {};
liveSuite("ide-zls real ZLS and Zig SDK", () => {
  let fixture, client, adapter, edge, timeout;
  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 90000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    fixture = createProject();
    const main = (await lumine.packages.activatePackage("ide-zls")).mainModule;
    lumine.config.set("ide-zls.serverPath", serverPath);
    lumine.config.set("ide-zls.zigPath", zigPath);
    edge = main.consumeIde({
      registerAdapter(value) {
        adapter = value;
        client = new LiveLspClient(value, fixture.rootPath);
        return { dispose() {} };
      },
    });
  });
  afterEach(async () => {
    await client.stop();
    edge.dispose();
    lumine.config.unset("ide-zls.serverPath");
    lumine.config.unset("ide-zls.zigPath");
    await lumine.packages.deactivatePackage("ide-zls");
    await removeProject(fixture.rootPath);
  });
  it("returns usable compiler diagnostics, intelligence, source edits, hints, tokens and ZON formatting", async () => {
    const { serverInfo } = await client.start();
    expect(serverInfo.version).toBe(process.env.ZLS_VERSION || "0.16.0");
    const covered = await exerciseServer(client, fixture);
    expect(covered).toContain("cross-file definition");
    expect(covered).toContain("standard library navigation");
    expect(covered).toContain("Unicode rename");
    expect(covered).toContain("ZON format");
    expect(covered).toContain("diagnostic clear");
  });
  it("downloads and launches the verified managed native archive through the shared installer", async () => {
    const packagePath = (await lumine.packages.loadPackage("ide")).path;
    const ManagedServers = require(path.join(packagePath, "lib", "managed-servers"));
    const Manager = require(path.join(packagePath, "lib", "language-server-manager"));
    const manager = new Manager();
    spyOn(manager, "reattachAll").and.resolveTo();
    const managed = new ManagedServers(manager, {
      storageRoot: path.join(fixture.rootPath, "managed"),
    });
    manager.setManagedServers(managed);
    manager.registerAdapter(adapter);
    try {
      const record = await managed.install(adapter.id, {
        version: process.env.ZLS_VERSION || "0.16.0",
      });
      expect(record.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
      lumine.config.set("ide-zls.serverPath", "");
      const { serverInfo } = await client.start(managed.installFor(adapter));
      expect(serverInfo.version).toBe(record.version);
      const covered = await exerciseServer(client, fixture);
      expect(covered).toContain("code actions");
    } finally {
      await client.stop();
      await manager.deactivate();
    }
  });
});
