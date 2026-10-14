const std = @import("std");

pub fn main() void {
    const samples = [_]f64{ 0.2, 0.8, -0.4, 0.5, 1.0 };
    var total: f64 = 0;
    for (samples) |sample| total += sample;

    const amplitude: f64 = 0.5
    std.debug.print("{d} {d}", .{ total, amplitude });
}
