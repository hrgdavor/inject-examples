const std = @import("std");

// The catalog is a region directive: the directive lines are never injected.
// #region catalog
const catalog = [_][]const u8{ "bolt", "nut", "washer" };
// #endregion

// Zig nests block comments, so the decoy below is invisible: /* fn decoy() */
/* fn decoy() void {} */

pub fn target() void {
    std.debug.print("}\n", .{});
}

/// The switch tests a literal, so `count` names the arm that compares against it.
pub fn count(methodName: []const u8) usize {
    switch (methodName.len) {
        "count".len => return catalog.len,
        else => return 0,
    }
}

pub fn legacy() usize { //old
    return catalog.len;
}
