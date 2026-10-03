const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const createProject = () => {
  const rootPath = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-zig-"));
  fs.mkdirSync(path.join(rootPath, "src"));
  const text = `const std = @import("std");
const math = @import("math.zig");
/// Add two numbers.
pub fn add(first:i32,second:i32)i32{return first+second;}
pub const Calculator = struct {
 value: i32,
 pub fn result(self: Calculator) i32 {return self.value;}
};
pub fn use() i32 {const emoji="😀"; _=emoji; return add(3,4);}
pub fn broken() void {var unused:i32=3;}
pub fn imported() i32 {return math.triple(2);}
test "addition" {try std.testing.expectEqual(@as(i32,7),add(3,4));}
`;
  const filePath = path.join(rootPath, "src", "main.zig"),
    zonPath = path.join(rootPath, "data.zon");
  fs.writeFileSync(filePath, text);
  const mathPath = path.join(rootPath, "src", "math.zig"),
    math = "/// Triple a number.\npub fn triple(value:i32)i32{return value*3;}\n";
  fs.writeFileSync(mathPath, math);
  const zon = '. { .name="fixture", .version="1.0.0", .enabled=true }\n';
  fs.writeFileSync(zonPath, zon.replace(". {", ".{"));
  const build = `const std = @import("std");
pub fn build(b: *std.Build) void {
    const module = b.createModule(.{ .root_source_file=b.path("src/main.zig"), .target=b.standardTargetOptions(.{}), .optimize=b.standardOptimizeOption(.{}) });
    const tests = b.addTest(.{ .root_module=module });
    const step = b.step("check", "Check the project");
    step.dependOn(&tests.step);
}
`;
  fs.writeFileSync(path.join(rootPath, "build.zig"), build);
  return {
    rootPath,
    filePath,
    text,
    uri: pathToFileURL(filePath).href,
    zonPath,
    zon: fs.readFileSync(zonPath, "utf8"),
    zonUri: pathToFileURL(zonPath).href,
    mathPath,
    math,
    mathUri: pathToFileURL(mathPath).href,
  };
};
const removeProject = (rootPath) => {
  const parent = fs.realpathSync.native(os.tmpdir()),
    target = path.resolve(rootPath);
  if (path.dirname(target) !== parent || !path.basename(target).startsWith("ide-zig-"))
    throw new Error(`Refusing to remove a non-test directory: ${target}`);
  return fs.promises.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
};
const position = (text, fragment, inside = 0) => {
  const offset = text.indexOf(fragment);
  if (offset < 0) throw new Error(`Missing fixture fragment ${fragment}`);
  const before = text.slice(0, offset + inside).split("\n");
  return { line: before.length - 1, character: before.at(-1).length };
};
const uriKey = (uri) =>
  fileURLToPath(uri).replace(/^([a-zA-Z]):/, (_, letter) => `${letter.toUpperCase()}:`);
module.exports = { createProject, removeProject, position, uriKey };
