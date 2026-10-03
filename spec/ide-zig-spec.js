const fs = require("node:fs");
const path = require("node:path");
const { createProject, removeProject } = require("./helpers/project");
describe("ide-zig executable discovery and managed releases", () => {
  let fixture, server;
  beforeEach(async () => {
    jasmine.useRealClock();
    fixture = createProject();
    await lumine.packages.activatePackage("ide-zig");
    server = require("../lib/server");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-zig");
    await removeProject(fixture.rootPath);
  });
  it("prefers the configured server over managed and system copies", async () => {
    spyOn(server, "resolveZig").and.resolveTo(process.execPath);
    spyOn(server, "probeVersion").and.resolveTo("0.16.0");
    const launch = await server.resolveServer(process.execPath, {
      binaryPath: path.join(fixture.rootPath, "missing"),
    });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([]);
    expect(launch.version).toBe("0.16.0");
  });
  it("uses the managed binary before searching PATH", async () => {
    spyOn(server, "resolveZig").and.resolveTo(process.execPath);
    spyOn(server, "probeVersion").and.resolveTo("0.16.0");
    spyOn(server, "findOnPath").and.returnValue(null);
    expect((await server.resolveServer("", { binaryPath: process.execPath })).command).toBe(
      process.execPath,
    );
    expect(server.findOnPath).not.toHaveBeenCalled();
  });
  it("finds native PATH executables while skipping directories and shell wrappers", () => {
    const name = path.basename(process.execPath, path.extname(process.execPath));
    expect(server.findOnPath(name, { PATH: path.dirname(process.execPath) })).toBeTruthy();
    fs.mkdirSync(path.join(fixture.rootPath, "zls"));
    fs.writeFileSync(path.join(fixture.rootPath, "zls.cmd"), "wrapper");
    expect(server.findOnPath("zls", { PATH: fixture.rootPath }, "win32")).toBeNull();
  });
  it("validates explicit SDK paths before starting a replacement server", async () => {
    expect(await server.resolveZig(process.execPath, { PATH: "" })).toBe(process.execPath);
    await expectAsync(server.resolveZig("relative/zig")).toBeRejectedWithError(/absolute/);
    await expectAsync(server.resolveZig(fixture.rootPath)).toBeRejectedWithError(/executable file/);
    await expectAsync(server.resolveServer(path.join(fixture.rootPath, "missing"))).toBeRejected();
  });
  it("refuses mismatching or development SDKs instead of running an incompatible build runner", async () => {
    spyOn(server, "resolveZig").and.resolveTo(process.execPath);
    spyOn(server, "probeVersion").and.callFake(async (_command, args) =>
      args[0] === "version" ? "0.15.2" : "0.16.0",
    );
    await expectAsync(server.resolveServer(process.execPath)).toBeRejectedWithError(
      /same major and minor/,
    );
    server.probeVersion.and.callFake(async (_command, args) =>
      args[0] === "version" ? "0.16.0-dev.123" : "0.16.0",
    );
    await expectAsync(server.resolveServer(process.execPath)).toBeRejectedWithError(/stable Zig/);
  });
  it("returns null when either the server or SDK is absent", async () => {
    spyOn(server, "findOnPath").and.returnValue(null);
    expect(await server.resolveServer()).toBeNull();
    spyOn(server, "resolveZig").and.resolveTo(null);
    expect(await server.resolveServer(process.execPath)).toBeNull();
  });
  it("selects official archive names across native platforms", () => {
    for (const [platform, arch, name] of [
      ["win32", "x64", "x86_64-windows.zip"],
      ["win32", "arm64", "aarch64-windows.zip"],
      ["darwin", "x64", "x86_64-macos.tar.xz"],
      ["darwin", "arm64", "aarch64-macos.tar.xz"],
      ["linux", "x64", "x86_64-linux.tar.xz"],
      ["linux", "arm64", "aarch64-linux.tar.xz"],
    ])
      expect(server.assetFor({ platform, arch })).toBe(`zls-${name}`);
    expect(server.assetFor({ platform: "darwin", arch: "ia32" })).toBeNull();
  });
  it("selects the release matching the active SDK minor version", async () => {
    spyOn(server, "resolveZig").and.resolveTo(process.execPath);
    spyOn(server, "probeVersion").and.resolveTo("0.15.2");
    const lookup = jasmine.createSpy("lookup").and.resolveTo({ version: "0.15.0" });
    expect(
      await server.latestServerVersion({
        githubReleaseByTag: lookup,
        latestGithubRelease: async () => ({ version: "0.16.0" }),
      }),
    ).toBe("0.15.0");
    expect(lookup).toHaveBeenCalledWith("zigtools/zls", "0.15.0");
  });
  it("fetches the current stable release when the SDK has not been installed", async () => {
    spyOn(server, "resolveZig").and.resolveTo(null);
    const lookup = jasmine.createSpy("latest").and.resolveTo({ version: "0.16.0" });
    expect(await server.latestServerVersion({ latestGithubRelease: lookup })).toBe("0.16.0");
    expect(lookup).toHaveBeenCalledWith("zigtools/zls");
  });
  it("verifies the published digest before extracting the native binary", async () => {
    const target = { platform: process.platform, arch: process.arch },
      asset = server.assetFor(target),
      digest = `sha256:${"a".repeat(64)}`;
    const api = {
      githubReleaseByTag: async () => ({
        version: "0.16.0",
        assets: [{ name: asset, url: "https://example.com/archive", digest }],
      }),
      downloadFile: jasmine
        .createSpy("download")
        .and.callFake(async (_url, directory) =>
          fs.writeFileSync(
            path.join(directory, process.platform === "win32" ? "zls.exe" : "zls"),
            "native",
          ),
        ),
      makeFileExecutable: async (file) => {
        if (process.platform !== "win32") fs.chmodSync(file, 0o755);
      },
      setServerInstallationStatus() {},
    };
    const installed = await server.installServer({
      storagePath: fixture.rootPath,
      version: "0.16.0",
      api,
    });
    expect(api.downloadFile.calls.mostRecent().args[2]).toEqual({
      type: process.platform === "win32" ? "zip" : "xz-tar",
      digest,
    });
    expect(installed.checksum).toBe(digest);
    expect(installed.version).toBe("0.16.0");
  });
  it("rejects missing assets or digests without downloading", async () => {
    const api = {
      githubReleaseByTag: async () => ({ version: "0.16.0", assets: [] }),
      downloadFile: jasmine.createSpy("download"),
      setServerInstallationStatus() {},
    };
    await expectAsync(
      server.installServer({ storagePath: fixture.rootPath, version: "0.16.0", api }),
    ).toBeRejectedWithError(/does not publish/);
    api.githubReleaseByTag = async () => ({
      version: "0.16.0",
      assets: [
        {
          name: server.assetFor({ platform: process.platform, arch: process.arch }),
          url: "https://example.com/server",
        },
      ],
    });
    await expectAsync(
      server.installServer({ storagePath: fixture.rootPath, version: "0.16.0", api }),
    ).toBeRejectedWithError(/SHA256/);
    expect(api.downloadFile).not.toHaveBeenCalled();
  });
});
describe("ide-zig service edges and actual settings", () => {
  let main, adapter, edge, cleanup;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("ide-zig")).mainModule;
    cleanup = jasmine.createSpy("cleanup");
    edge = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose: cleanup };
      },
    });
  });
  afterEach(async () => {
    edge.dispose();
    for (const key of ["zigPath", "buildOnSave", "parameterHints"])
      lumine.config.unset(`ide-zig.${key}`);
    await lumine.packages.deactivatePackage("ide-zig");
  });
  it("registers Zig and returns the exact provider-edge disposable", () => {
    expect(adapter.grammarScopes).toEqual(["source.zig"]);
    expect(adapter.languageId).toBe("zig");
    edge.dispose();
    expect(cleanup).toHaveBeenCalled();
    expect(main.provideBackgroundTips().packageName).toBe("ide-zig");
  });
  it("keeps separately supplied client edges independent", () => {
    const secondCleanup = jasmine.createSpy("second"),
      second = main.consumeIdeClient({
        registerAdapter() {
          return { dispose: secondCleanup };
        },
      });
    edge.dispose();
    expect(secondCleanup).not.toHaveBeenCalled();
    second.dispose();
    expect(secondCleanup).toHaveBeenCalled();
  });
  it("preserves project build policy and server hint defaults", async () => {
    spyOn(require("../lib/server"), "resolveZig").and.resolveTo(null);
    expect(await adapter.getSettings()).toEqual({});
    expect(adapter.getWorkspaceConfiguration("other")).toBeUndefined();
  });
  it("sends only supported settings in the flat zls configuration namespace", async () => {
    spyOn(require("../lib/server"), "resolveZig").and.resolveTo(process.execPath);
    lumine.config.set("ide-zig.buildOnSave", "disabled");
    lumine.config.set("ide-zig.parameterHints", "enabled");
    const expected = {
      zig_exe_path: process.execPath,
      enable_build_on_save: false,
      inlay_hints_show_parameter_name: true,
    };
    expect(await adapter.getWorkspaceConfiguration("zls")).toEqual(expected);
    expect(await adapter.getInitializationOptions()).toEqual(expected);
  });
  it("keeps unsupported ZON features unavailable without breaking scope-only diagnostic contexts", () => {
    const zon = { getPath: () => "/project/data.zon" };
    for (const feature of [
      "hover",
      "autocomplete",
      "signature",
      "definition",
      "references",
      "rename",
      "symbols",
      "codeActions",
      "inlayHints",
    ])
      expect(adapter.isFeatureAvailable(feature, zon)).toBe(false);
    for (const feature of ["diagnostics", "format", "semanticTokens"])
      expect(adapter.isFeatureAvailable(feature, zon)).toBe(true);
    expect(
      adapter.isFeatureAvailable("diagnostics", { getRootScopeDescriptor: () => ["source.zig"] }),
    ).toBe(true);
  });
  it("reacquires a fresh main module after unloading the package generation", async () => {
    const packagePath = lumine.packages.getActivePackage("ide-zig").path;
    await lumine.packages.deactivatePackage("ide-zig");
    await lumine.packages.unloadPackage("ide-zig");
    await lumine.packages.loadPackage(packagePath);
    const current = (await lumine.packages.activatePackage("ide-zig")).mainModule;
    expect(current).not.toBe(main);
    expect(current.provideBackgroundTips().packageName).toBe("ide-zig");
  });
  it("reports missing SDK or ZLS through the shared missing-server UI", async () => {
    spyOn(require("../lib/server"), "resolveServer").and.resolveTo(null);
    const missing = jasmine.createSpy("missing");
    let registered;
    const registration = main.consumeIdeClient({
      registerAdapter(value) {
        registered = value;
        return { dispose() {} };
      },
      reportMissingServer: missing,
    });
    try {
      expect(await registered.resolveServer({ rootPath: "/project" })).toBeNull();
      expect(missing.calls.mostRecent().args[0]).toBe("ide-zig");
    } finally {
      registration.dispose();
    }
  });
});
