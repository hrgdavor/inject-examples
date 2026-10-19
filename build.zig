const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // The library module: everything `index.mjs` exports, importable as
    // `@import("inject_examples")` (also by consumers of this package).
    const mod = b.addModule("inject_examples", .{
        .root_source_file = b.path("src/root.zig"),
        // A target is required because the module is also tested directly.
        .target = target,
    });

    // The CLI executable. Its `--version` is read from package.json at build
    // time, so the JavaScript package and the Zig twin cannot drift when the
    // release version changes; there is no second copy to update.
    const build_options = b.addOptions();
    build_options.addOption([]const u8, "version", packageVersion(b));
    const exe = b.addExecutable(.{
        .name = "inject-examples",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "inject_examples", .module = mod },
                .{ .name = "build_options", .module = build_options.createModule() },
            },
        }),
    });
    // `.dest_dir = .{ .override = .prefix }` installs the binary directly into
    // zig-out/ instead of zig-out/bin/, which is where `tools/compare-zig.mjs`
    // looks for it. The release workflow's packaging paths must stay in step
    // with this (see .github/workflows/release.yml).
    const install_exe = b.addInstallArtifact(exe, .{
        .dest_dir = .{ .override = .prefix },
    });
    b.getInstallStep().dependOn(&install_exe.step);

    const run_step = b.step("run", "Run the injector");
    const run_cmd = b.addRunArtifact(exe);
    run_step.dependOn(&run_cmd.step);
    // Run from the install directory rather than the cache.
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);

    const mod_tests = b.addTest(.{ .root_module = mod });
    const run_mod_tests = b.addRunArtifact(mod_tests);

    const exe_tests = b.addTest(.{ .root_module = exe.root_module });
    const run_exe_tests = b.addRunArtifact(exe_tests);

    const test_step = b.step("test", "Run tests");
    test_step.dependOn(&run_mod_tests.step);
    test_step.dependOn(&run_exe_tests.step);
}

/// The `version` field of the package manifest, which is the one source of
/// truth both tools print. A missing or malformed package.json is a build
/// error, not a silently stale version.
fn packageVersion(b: *std.Build) []const u8 {
    const package_json = @embedFile("package.json");
    const parsed = std.json.parseFromSlice(std.json.Value, b.allocator, package_json, .{}) catch @panic("cannot parse package.json");
    const version = parsed.value.object.get("version") orelse @panic("package.json has no version");
    return version.string;
}
