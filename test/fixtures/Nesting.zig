//! A Zig file whose nested block comment hides a declaration.
const std = @import("std");

/* outer /* inner */ fn decoy() void { x(); } */

/// The real target.
fn target() void {
    z();
}
