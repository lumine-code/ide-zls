const { serverApi } = require("./helpers/server-resolver");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

describe("ZLS installation SDK lifetime", () => {
  beforeEach(() => jasmine.useRealClock());
  for (const operation of ["latest", "install"]) {
    it(`rejects an expired ${operation} SDK probe without starting release discovery`, async () => {
      const server = require("../lib/server");
      const controller = new AbortController();
      const reason = new DOMException("Installation canceled", "AbortError");
      let entered, finish;
      const started = new Promise((resolve) => (entered = resolve));
      spyOn(server, "probeVersion").and.callFake(
        (_command, _args, options = {}) =>
          new Promise((resolve, reject) => {
            entered();
            finish = () => resolve("0.16.0");
            options.signal?.addEventListener("abort", () => reject(options.signal.reason), {
              once: true,
            });
          }),
      );
      const api = serverApi({
        signal: controller.signal,
        latestGithubRelease: jasmine
          .createSpy("latest release")
          .and.resolveTo({ version: "0.16.0" }),
        githubReleaseByTag: jasmine
          .createSpy("release by tag")
          .and.resolveTo({ version: "0.16.0", assets: [] }),
      });
      const pending =
        operation === "latest"
          ? server.latestServerVersion(api, process.execPath)
          : server.installServer(
              { storagePath: __dirname, version: "0.16.0", api, signal: controller.signal },
              process.execPath,
            );
      const outcome = pending.catch((error) => error);
      await started;
      controller.abort(reason);
      finish();
      expect(await outcome).toBe(reason);
      expect(api.latestGithubRelease).not.toHaveBeenCalled();
      expect(api.githubReleaseByTag).not.toHaveBeenCalled();
    });
  }

  it("preserves cancellation from a real SDK process and never spawns with an expired signal", async () => {
    const server = require("../lib/server");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ide-zig-lifetime-"));
    const marker = path.join(directory, "started.json");
    const controller = new AbortController();
    const reason = new DOMException("Installation canceled", "AbortError");
    const spawn = spyOn(childProcess, "execFile").and.callThrough();
    const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '{}'); console.log('0.16.0'); setInterval(() => {}, 1000);`;
    const pending = server.probeVersion(process.execPath, ["-e", source], {
      signal: controller.signal,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    const outcome = pending.catch((error) => error);
    const child = spawn.calls.mostRecent().returnValue;
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(marker) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fs.existsSync(marker)).toBe(true);
      controller.abort(reason);
      expect(await outcome).toBe(reason);
      await closed;
      const calls = spawn.calls.count();
      await expectAsync(
        server.probeVersion(process.execPath, ["-e", ""], { signal: controller.signal }),
      ).toBeRejectedWith(reason);
      expect(spawn.calls.count()).toBe(calls);
    } finally {
      controller.abort(reason);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      await outcome;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
});
