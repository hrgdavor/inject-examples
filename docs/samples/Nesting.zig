const std = @import("std");

// Zig nests block comments, so the decoy below is invisible: /* fn decoy() */
/* fn decoy() void {} */

pub fn target() void {
    std.debug.print("}\n", .{});
}
