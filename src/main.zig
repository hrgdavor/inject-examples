//! `inject-examples` CLI - the Zig twin of `cli.mjs`.
//!
//! **The JavaScript implementation is the source of truth.** `index.mjs` and
//! `cli.mjs` define the behaviour; this program exists to print the same bytes,
//! on the same inputs, with the same exit codes. Where the two disagree, the
//! JavaScript is right and this file is the bug. See the "The Zig port" section
//! of `README.md`.
//!
//! Exit codes, as documented in the README: `0` every block is up to date or was
//! rewritten, `1` a block is stale in `--check` mode, a document is malformed,
//! or (with `--lenient`) an include could not be resolved, `2` the command line
//! was wrong.
//!
//! Paths are handled as bytes exactly as Node hands them over (`std.fs.path`
//! mirrors `node:path` on Windows), and messages that come out of the library
//! are UTF-16 code units, so output is byte-identical to the JS tool's.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const inject = @import("inject_examples");

const Str = inject.Str;
const Failure = inject.Failure;

const DEFAULT_FILE = "README.md";
/// A directory target expands to files with this suffix.
const MARKDOWN_SUFFIX = ".md";

const OK: u8 = 0;
const FAILED: u8 = 1;
const USAGE: u8 = 2;

/// Mirrors `version()` in `cli.mjs`, which reads `package.json` at runtime.
const VERSION = "1.1.0";

/// The `HELP` template in `cli.mjs`, with every `\${...}` already filled in and
/// every escaped backtick unescaped: byte for byte what `--help` prints.
const HELP =
    \\inject-examples — keep Markdown examples in sync with real files
    \\
    \\Usage:
    \\  inject-examples [options] [file|dir ...]
    \\
    \\  Each marker in `file` is a line that is nothing but a link to a real path,
    \\  labelled with that same path, followed by a fenced code block:
    \\
    \\      [fixtures/before.md](./fixtures/before.md)
    \\
    \\      ```markdown
    \\      ...replaced, byte for byte, with that file...
    \\      ```
    \\
    \\  A fence without a language is given one from the file's extension, so the
    \\  block highlights; a fence that already names a language is left as written.
    \\
    \\  Name a region in the fragment to inject part of a larger file. How the
    \\  reference is read depends on the file's type. A code file (or any type
    \\  without a rule of its own) takes a #region directive, or the name of a
    \\  method or inner class — optionally prefixed with - for its body alone, + to
    \\  include the annotations above it, or ++ to include its doc comment too. A
    \\  .json file, which has no comments, takes a comma-separated list of dotted
    \\  key paths, rendered as valid JSON:
    \\
    \\      [src/app.ts](./src/app.ts#region:table)
    \\      [src/app.ts](./src/app.ts#region:++table)
    \\      [package.json](./package.json#region:scripts.test,name)
    \\
    \\Arguments:
    \\  file|dir             Markdown document(s) to update. A directory expands to
    \\                       every *.md below it, recursively; node_modules and
    \\                       dot-directories are skipped. Default: README.md
    \\
    \\Options:
    \\  -c, --check          Write nothing; exit 1 if any block is stale
    \\  -n, --dry-run        Write nothing; report what would change
    \\  -o, --out <file>     Write the processed document to <file> instead of
    \\                        updating the input in place: the input is never
    \\                        modified, <file> may live in any folder (its missing
    \\                        parent directories are created), and exactly one
    \\                        input file is required
    \\  -r, --root <dir>     Base directory for the paths the markers name
    \\                       (default: the directory holding the document)
    \\  -g, --gitignore <file> Skip markers whose target file is ignored by this
    \\                       .gitignore file (default: search upward from the
    \\                       document's directory, like git)
    \\      --no-gitignore   Do not apply any .gitignore rules
    \\  -q, --quiet          Print only the closing summary
    \\      --allow-empty    Succeed when the document contains no markers
    \\  -l, --lenient        Tolerate broken includes: a marker whose file, region
    \\                       or block cannot be resolved is reported with its line
    \\                       number and its block is left as written; the exit code
    \\                       is still 1 when any such marker occurs
    \\  -h, --help           Show this help
    \\  -V, --version        Show the version
    \\
    \\Exit codes:
    \\  0  every block is up to date (or was rewritten)
    \\  1  a block is stale in --check mode, a document is malformed,
    \\             or (with --lenient) an include could not be resolved
    \\  2  the command line was wrong
    \\
    \\  With several documents the run processes all of them, including the ones
    \\  after a failure, and exits with the worst code it saw.
    \\
;

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/// `parseArgs`'s options object.
const Args = struct {
    files: []const []const u8 = &.{},
    root: ?[]const u8 = null,
    gitignore_file: ?[]const u8 = null,
    no_gitignore: bool = false,
    check: bool = false,
    dry_run: bool = false,
    out: ?[]const u8 = null,
    quiet: bool = false,
    allow_empty: bool = false,
    lenient: bool = false,
    help: bool = false,
    version: bool = false,
};

const Parsed = union(enum) {
    ok: Args,
    /// The `UsageError` message `main` reports before returning `USAGE`.
    usage: []const u8,
};

fn eqAscii(text: []const u8, comptime literal: []const u8) bool {
    return std.mem.eql(u8, text, literal);
}

fn startsAscii(text: []const u8, comptime prefix: []const u8) bool {
    return std.mem.startsWith(u8, text, prefix);
}

/// Parse argv (already free of `node script`), exactly as `parseArgs` does.
fn parseArgs(alloc: Allocator, argv: []const []const u8) !Parsed {
    var options = Args{};
    var positionals = std.ArrayList([]const u8).empty;
    var only_positionals = false;

    var i: usize = 0;
    while (i < argv.len) : (i += 1) {
        const arg = argv[i];

        if (only_positionals or !startsAscii(arg, "-") or eqAscii(arg, "-")) {
            try positionals.append(alloc, arg);
            continue;
        }
        if (eqAscii(arg, "--")) {
            only_positionals = true;
            continue;
        }

        if (eqAscii(arg, "-c") or eqAscii(arg, "--check")) {
            options.check = true;
            continue;
        }
        if (eqAscii(arg, "-n") or eqAscii(arg, "--dry-run")) {
            options.dry_run = true;
            continue;
        }
        if (eqAscii(arg, "-q") or eqAscii(arg, "--quiet")) {
            options.quiet = true;
            continue;
        }
        if (eqAscii(arg, "-l") or eqAscii(arg, "--lenient")) {
            options.lenient = true;
            continue;
        }
        if (eqAscii(arg, "--allow-empty")) {
            options.allow_empty = true;
            continue;
        }
        if (eqAscii(arg, "-h") or eqAscii(arg, "--help")) {
            options.help = true;
            continue;
        }
        if (eqAscii(arg, "-V") or eqAscii(arg, "--version")) {
            options.version = true;
            continue;
        }
        if (eqAscii(arg, "--no-gitignore")) {
            options.no_gitignore = true;
            continue;
        }
        if (eqAscii(arg, "-o") or eqAscii(arg, "--out")) {
            if (i + 1 >= argv.len) return .{ .usage = try needValue(alloc, arg) };
            i += 1;
            options.out = argv[i];
            continue;
        }
        if (eqAscii(arg, "-r") or eqAscii(arg, "--root")) {
            if (i + 1 >= argv.len) return .{ .usage = try needValue(alloc, arg) };
            i += 1;
            options.root = argv[i];
            continue;
        }
        if (eqAscii(arg, "-g") or eqAscii(arg, "--gitignore")) {
            if (i + 1 >= argv.len) return .{ .usage = try needValue(alloc, arg) };
            i += 1;
            options.gitignore_file = argv[i];
            continue;
        }

        if (startsAscii(arg, "--root=")) {
            options.root = arg["--root=".len..];
            continue;
        }
        if (startsAscii(arg, "--out=")) {
            options.out = arg["--out=".len..];
            continue;
        }
        if (startsAscii(arg, "--gitignore=")) {
            options.gitignore_file = arg["--gitignore=".len..];
            continue;
        }
        return .{ .usage = try std.fmt.allocPrint(alloc, "unknown option: {s}", .{arg}) };
    }

    if (options.gitignore_file != null and options.no_gitignore) {
        return .{ .usage = "--gitignore and --no-gitignore cannot be used together" };
    }
    if (positionals.items.len > 0) {
        options.files = try positionals.toOwnedSlice(alloc);
    } else {
        const fallback = try alloc.alloc([]const u8, 1);
        fallback[0] = DEFAULT_FILE;
        options.files = fallback;
    }
    return .{ .ok = options };
}

fn needValue(alloc: Allocator, name: []const u8) ![]const u8 {
    return std.fmt.allocPrint(alloc, "{s} needs a value", .{name});
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/// Both streams, buffered; `flush` is mandatory before exiting because
/// `std.process.exit` does not flush.
const Cli = struct {
    alloc: Allocator,
    io: Io,
    stdout_buffer: [16 * 1024]u8 = undefined,
    stderr_buffer: [16 * 1024]u8 = undefined,
    stdout_writer: Io.File.Writer = undefined,
    stderr_writer: Io.File.Writer = undefined,

    fn start(self: *Cli) void {
        self.stdout_writer = .init(.stdout(), self.io, &self.stdout_buffer);
        self.stderr_writer = .init(.stderr(), self.io, &self.stderr_buffer);
    }

    fn flush(self: *Cli) void {
        self.stdout_writer.interface.flush() catch {};
        self.stderr_writer.interface.flush() catch {};
    }

    /// `console.log`: the formatted line plus a newline.
    fn print(self: *Cli, comptime template: []const u8, args: anytype) void {
        self.stdout_writer.interface.print(template, args) catch {};
    }

    /// `console.error`.
    fn printErr(self: *Cli, comptime template: []const u8, args: anytype) void {
        self.stderr_writer.interface.print(template, args) catch {};
    }

    /// A line whose text is a JavaScript string (UTF-16 code units).
    fn printLineUnits(self: *Cli, units: Str) void {
        const bytes = inject.utf8Encode(self.alloc, units) catch return;
        self.stdout_writer.interface.writeAll(bytes) catch {};
        self.stdout_writer.interface.writeAll("\n") catch {};
    }

    fn printErrUnits(self: *Cli, units: Str) void {
        const bytes = inject.utf8Encode(self.alloc, units) catch return;
        self.stderr_writer.interface.writeAll(bytes) catch {};
    }

    // ---------------------------------------------------------------------
    // Paths
    // ---------------------------------------------------------------------

    /// `path.resolve(path)`: the one-argument form, which anchors a relative path
    /// to the working directory. Zig's `std.fs.path.resolve` only normalizes, so
    /// the working directory has to be named explicitly.
    fn resolvePath(self: *Cli, path: []const u8) ![]const u8 {
        const cwd = std.process.currentPathAlloc(self.io, self.alloc) catch return path;
        return std.fs.path.resolve(self.alloc, &.{ cwd, path });
    }

    /// `display(path)`: the path as the user typed it, when that is shorter and
    /// still unambiguous.
    fn display(self: *Cli, path: []const u8) ![]const u8 {
        const cwd = std.process.currentPathAlloc(self.io, self.alloc) catch return path;
        const rel = std.fs.path.relative(self.alloc, cwd, null, cwd, path) catch return path;
        if (rel.len == 0 or std.mem.startsWith(u8, rel, "..")) return path;
        return rel;
    }

    /// `readOrNull(path)`: the file's bytes, or null when it cannot be read.
    fn readOrNull(self: *Cli, path: []const u8) ?[]u8 {
        return Io.Dir.cwd().readFileAlloc(self.io, path, self.alloc, .unlimited) catch null;
    }

    /// The message Node puts in `err.message` for a failed filesystem call.
    fn reasonText(
        self: *Cli,
        err: anyerror,
        stage: Stage,
        path: []const u8,
    ) ![]const u8 {
        const operation = switch (stage) {
            .reading, .writing => "open",
            .scandir => "scandir",
            .stat => "stat",
            .mkdir => "mkdir",
        };
        const absolute = try self.resolvePath(path);
        return switch (err) {
            error.FileNotFound => try std.fmt.allocPrint(
                self.alloc,
                "ENOENT: no such file or directory, {s} '{s}'",
                .{ operation, absolute },
            ),
            error.IsDir => switch (stage) {
                // Node opens the directory fine and fails at the read.
                .reading => "EISDIR: illegal operation on a directory, read",
                else => try std.fmt.allocPrint(
                    self.alloc,
                    "EISDIR: illegal operation on a directory, {s} '{s}'",
                    .{ operation, absolute },
                ),
            },
            error.AccessDenied, error.PermissionDenied => try std.fmt.allocPrint(
                self.alloc,
                "EACCES: permission denied, {s} '{s}'",
                .{ operation, absolute },
            ),
            error.NotDir => try std.fmt.allocPrint(
                self.alloc,
                "ENOTDIR: not a directory, {s} '{s}'",
                .{ operation, absolute },
            ),
            else => try std.fmt.allocPrint(
                self.alloc,
                "EIO: i/o error, {s} '{s}'",
                .{ operation, absolute },
            ),
        };
    }

    /// `statSync(path, { throwIfNoEntry: false })`: null when there is nothing
    /// there, and the Node message when the stat itself fails.
    fn statOrNull(self: *Cli, path: []const u8, failure: *Failure) inject.JsError!?Io.Dir.Stat {
        const stat = Io.Dir.cwd().statFile(self.io, path, .{}) catch |err| {
            if (err == error.FileNotFound) return null;
            const reason = try self.reasonText(err, .stat, path);
            return failure.set(try inject.utf8Decode(self.alloc, reason));
        };
        return stat;
    }
};

const Stage = enum { reading, writing, scandir, stat, mkdir };

/// The `readFile(relativePath)` the library is handed: `fileReader(root)` in
/// JavaScript, which resolves against the root and reads what is there.
const ReadContext = struct {
    cli: *Cli,
    root: []const u8,
};

fn cliReadFile(
    context: ?*anyopaque,
    alloc: Allocator,
    relative_path: []const u8,
    failure: *Failure,
) inject.JsError![]u8 {
    const self: *ReadContext = @ptrCast(@alignCast(context.?));
    const full = std.fs.path.resolve(alloc, &.{ self.root, relative_path }) catch
        try alloc.dupe(u8, relative_path);
    return Io.Dir.cwd().readFileAlloc(self.cli.io, full, alloc, .unlimited) catch |err| {
        const reason = try self.cli.reasonText(err, .reading, full);
        return failure.set(try inject.utf8Decode(alloc, reason));
    };
}

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

const Entry = struct {
    name: []const u8,
    kind: Io.File.Kind,

    fn lessThan(_: void, left: Entry, right: Entry) bool {
        return std.mem.lessThan(u8, left.name, right.name);
    }
};

/// `collectMarkdown`: every `*.md` below `dir`, recursively, in name order.
/// `node_modules` and dot-directories are skipped.
fn collectMarkdown(
    cli: *Cli,
    dir: []const u8,
    found: *std.ArrayList([]const u8),
    failure: *Failure,
) inject.JsError!void {
    var handle = Io.Dir.cwd().openDir(cli.io, dir, .{ .iterate = true }) catch |err| {
        const reason = try cli.reasonText(err, .scandir, dir);
        return failure.set(try inject.utf8Decode(cli.alloc, reason));
    };
    defer handle.close(cli.io);

    var entries = std.ArrayList(Entry).empty;
    var iterator = handle.iterate();
    while (true) {
        const entry = iterator.next(cli.io) catch |err| {
            const reason = try cli.reasonText(err, .scandir, dir);
            return failure.set(try inject.utf8Decode(cli.alloc, reason));
        } orelse break;
        try entries.append(cli.alloc, .{
            .name = try cli.alloc.dupe(u8, entry.name),
            .kind = entry.kind,
        });
    }
    std.mem.sort(Entry, entries.items, {}, Entry.lessThan);

    for (entries.items) |entry| {
        if (std.mem.eql(u8, entry.name, "node_modules")) continue;
        if (entry.name.len > 0 and entry.name[0] == '.') continue;
        const full = try std.fs.path.join(cli.alloc, &.{ dir, entry.name });
        if (entry.kind == .directory) {
            try collectMarkdown(cli, full, found, failure);
        } else if (entry.kind == .file and std.mem.endsWith(u8, entry.name, MARKDOWN_SUFFIX)) {
            try found.append(cli.alloc, full);
        }
    }
}

const Documents = struct {
    documents: []const []const u8,
    code: u8,
};

/// `resolveDocuments`: a file is taken as it is, a directory expands to its
/// Markdown documents, and a path that cannot be read is kept so the read
/// reports it.
fn resolveDocuments(
    cli: *Cli,
    targets: []const []const u8,
    failure: *Failure,
) inject.JsError!Documents {
    var documents = std.ArrayList([]const u8).empty;
    var code: u8 = OK;

    for (targets) |target| {
        const full = try cli.resolvePath(target);
        const stat = try cli.statOrNull(full, failure);
        if (stat == null or stat.?.kind != .directory) {
            try documents.append(cli.alloc, full);
            continue;
        }
        var found = std.ArrayList([]const u8).empty;
        try collectMarkdown(cli, full, &found, failure);
        if (found.items.len == 0) {
            cli.printErr("inject-examples: no Markdown (*.md) documents below {s}.\n", .{try cli.display(full)});
            code = FAILED;
            continue;
        }
        try documents.appendSlice(cli.alloc, found.items);
    }

    // `[...new Set(documents)]`, keeping the first occurrence of each.
    var unique = std.ArrayList([]const u8).empty;
    for (documents.items) |document| {
        var seen = false;
        for (unique.items) |existing| {
            if (std.mem.eql(u8, existing, document)) seen = true;
        }
        if (!seen) try unique.append(cli.alloc, document);
    }
    return .{ .documents = unique.items, .code = code };
}

// ---------------------------------------------------------------------------
// Gitignore
// ---------------------------------------------------------------------------

/// `loadGitignore`: the setting for a run, or false after reporting a read
/// failure (because then no document could be processed correctly).
fn loadGitignore(
    cli: *Cli,
    options: Args,
    ignore: *inject.Gitignore,
) inject.JsError!bool {
    if (options.no_gitignore) {
        ignore.* = .off;
        return true;
    }
    const file_option = options.gitignore_file orelse {
        ignore.* = .walk_up;
        return true;
    };

    const ignore_file = try cli.resolvePath(file_option);
    const text = Io.Dir.cwd().readFileAlloc(cli.io, ignore_file, cli.alloc, .unlimited) catch |err| {
        const reason = if (err == error.FileNotFound)
            "no such file"
        else
            try cli.reasonText(err, .reading, ignore_file);
        cli.printErr("inject-examples: cannot read gitignore file {s}: {s}\n", .{
            try cli.display(ignore_file),
            reason,
        });
        return false;
    };

    const units = try inject.utf8Decode(cli.alloc, text);
    const rules = try inject.parseIgnoreFile(cli.alloc, units);
    const files = try cli.alloc.alloc(inject.RuleFile, 1);
    files[0] = .{
        .dir = std.fs.path.dirname(ignore_file) orelse ignore_file,
        .rules = rules,
    };
    ignore.* = .{ .rules = files };
    return true;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

fn run(cli: *Cli, argv: []const []const u8, failure: *Failure) inject.JsError!u8 {
    const alloc = cli.alloc;

    var options: Args = undefined;
    switch (try parseArgs(alloc, argv)) {
        .usage => |message| {
            cli.printErr("inject-examples: {s}\n", .{message});
            cli.printErr("Try: inject-examples --help\n", .{});
            return USAGE;
        },
        .ok => |parsed| options = parsed,
    }

    if (options.out) |target| {
        // --out processes one document into a separate file, so the target must
        // be exactly one file: a directory or several files is a wrong command
        // line, not a document to process.
        if (options.files.len != 1) {
            cli.printErr("inject-examples: --out needs exactly one input file\n", .{});
            cli.printErr("Try: inject-examples --help\n", .{});
            return USAGE;
        }
        const full = try cli.resolvePath(options.files[0]);
        if (try cli.statOrNull(full, failure)) |stat| {
            if (stat.kind == .directory) {
                cli.printErr("inject-examples: --out needs a file, not a directory: {s}\n", .{
                    try cli.display(options.files[0]),
                });
                cli.printErr("Try: inject-examples --help\n", .{});
                return USAGE;
            }
        }
        _ = target;
    }

    if (options.help) {
        cli.stdout_writer.interface.writeAll(HELP) catch {};
        return OK;
    }
    if (options.version) {
        cli.print("{s}\n", .{VERSION});
        return OK;
    }

    var gitignore: inject.Gitignore = .walk_up;
    if (!try loadGitignore(cli, options, &gitignore)) return FAILED;

    const resolved = try resolveDocuments(cli, options.files, failure);
    var exit_code = resolved.code;
    for (resolved.documents) |document| {
        // Every document is processed, including the ones after a failure: one
        // broken page must not hold the healthy ones hostage.
        const code = try processDocument(cli, document, options, gitignore, failure);
        exit_code = @max(exit_code, code);
    }
    return exit_code;
}

/// `processDocument`: update, check or dry-run one document.
fn processDocument(
    cli: *Cli,
    file: []const u8,
    options: Args,
    gitignore: inject.Gitignore,
    failure: *Failure,
) inject.JsError!u8 {
    const alloc = cli.alloc;
    // `root` is `dirname(file)` in JavaScript, which its `fileReader` then
    // resolves; resolving here too keeps every path the library builds absolute
    // (Zig's `resolve` does not anchor a relative path to the working
    // directory the way `node:path` does).
    const root = if (options.root) |given|
        try cli.resolvePath(given)
    else
        try cli.resolvePath(std.fs.path.dirname(file) orelse ".");

    const raw = Io.Dir.cwd().readFileAlloc(cli.io, file, alloc, .unlimited) catch |err| {
        const reason = if (err == error.FileNotFound)
            "no such file"
        else
            try cli.reasonText(err, .reading, file);
        cli.printErr("inject-examples: cannot read {s}: {s}\n", .{ try cli.display(file), reason });
        return FAILED;
    };
    const original = try inject.utf8Decode(alloc, raw);

    var context = ReadContext{ .cli = cli, .root = root };
    const reader = inject.Reader{ .context = @ptrCast(&context), .read_fn = cliReadFile };

    var document_failure = Failure{};
    const result = inject.updateDocument(alloc, original, .{
        .root = root,
        .read_file = reader,
        .gitignore = gitignore,
        .lenient = options.lenient,
    }, &document_failure) catch |err| switch (err) {
        error.Failed => {
            cli.printErr("inject-examples: {s}: ", .{try cli.display(file)});
            cli.printErrUnits(document_failure.message);
            cli.printErr("\n", .{});
            return FAILED;
        },
        else => return err,
    };

    const total = result.markers.len;
    if (total == 0) {
        if (!options.allow_empty) {
            cli.printErr("inject-examples: no injection markers found in {s}.\n", .{try cli.display(file)});
            cli.printErr("A marker is a line that is nothing but a link to a file it names; see --help.\n", .{});
            return FAILED;
        }
        cli.print("{s}: no markers, nothing to do.\n", .{try cli.display(file)});
        return OK;
    }

    var stale: usize = 0;
    var failed: usize = 0;
    var skipped_count: usize = 0;
    for (result.results) |entry| {
        if (entry.changed) stale += 1;
        if (entry.skipped) {
            if (entry.failure != null) failed += 1 else skipped_count += 1;
        }
    }
    const checked = total - skipped_count - failed;
    const skip_note = if (skipped_count > 0)
        try std.fmt.allocPrint(alloc, ", {d} marker(s) skipped", .{skipped_count})
    else
        "";
    const failed_note = if (failed > 0)
        try std.fmt.allocPrint(alloc, ", {d} failed", .{failed})
    else
        "";

    if (!options.quiet) {
        // In --check and --dry-run nothing is written, so a difference is a
        // finding ("stale"), not an action taken ("updated"). A failure-skip is
        // a failure ("failed"), distinct from a gitignored "skipped".
        const read_only = options.check or options.dry_run;
        for (result.results) |entry| {
            const label: []const u8 = if (entry.failure != null)
                "failed"
            else if (entry.skipped)
                "skipped"
            else if (entry.changed)
                (if (read_only) "stale" else "updated")
            else
                "ok";
            cli.print("{s: <7}  ", .{label});
            cli.printLineUnits(entry.marker.raw);
        }
        for (result.results) |entry| {
            if (entry.failure) |reason| {
                cli.printErr("inject-examples: warn: {s}:{d}: ", .{
                    try cli.display(file),
                    entry.marker.index + 1,
                });
                cli.printErrUnits(entry.marker.raw);
                cli.printErr(": ", .{});
                cli.printErrUnits(reason);
                cli.printErr("\n", .{});
            }
        }
    }

    if (options.out) |out_option| {
        const out = try cli.resolvePath(out_option);
        const current = cli.readOrNull(out);
        const changed = if (current) |bytes|
            !try normalizedEqual(alloc, bytes, result.text)
        else
            true;

        if (options.check) {
            if (failed > 0) {
                cli.printErr("\n{s}: {d} of {d} marker(s) could not be resolved; {s} was not verified.\n", .{
                    try cli.display(file),
                    failed,
                    total,
                    try cli.display(out_option),
                });
                return FAILED;
            }
            if (!changed) {
                cli.print("\n{s} is up to date with respect to {s}.\n", .{
                    try cli.display(out_option),
                    try cli.display(file),
                });
                return OK;
            }
            cli.printErr("\n{s} is stale with respect to {s}{s}.\n", .{
                try cli.display(out_option),
                try cli.display(file),
                if (current == null) " (the file does not exist)" else "",
            });
            cli.printErr("Run: inject-examples --out {s} {s}\n", .{
                try cli.display(out_option),
                try cli.display(file),
            });
            return FAILED;
        }

        if (options.dry_run) {
            if (failed > 0) {
                cli.print("\n{s}: {d} marker(s) could not be resolved and would be left as written{s}.\n", .{
                    try cli.display(file),
                    failed,
                    skip_note,
                });
                return FAILED;
            }
            if (!changed) {
                cli.print("\n{s} is already in sync with {s}{s}.\n", .{
                    try cli.display(file),
                    try cli.display(out_option),
                    skip_note,
                });
            } else if (stale > 0) {
                cli.print("\n{s} would write {s}: {d} of {d} block(s) updated{s}.\n", .{
                    try cli.display(file),
                    try cli.display(out_option),
                    stale,
                    checked,
                    skip_note,
                });
            } else {
                cli.print("\n{s} would write {s}{s}.\n", .{
                    try cli.display(file),
                    try cli.display(out_option),
                    skip_note,
                });
            }
            return OK;
        }

        const out_dir = std.fs.path.dirname(out) orelse out;
        Io.Dir.cwd().createDirPath(cli.io, out_dir) catch |err| {
            const reason = try cli.reasonText(err, .mkdir, out_dir);
            return failure.set(try inject.utf8Decode(alloc, reason));
        };
        if (changed) {
            const bytes = try inject.utf8Encode(alloc, result.text);
            Io.Dir.cwd().writeFile(cli.io, .{ .sub_path = out, .data = bytes }) catch |err| {
                const reason = try cli.reasonText(err, .writing, out);
                return failure.set(try inject.utf8Decode(alloc, reason));
            };
        }
        if (failed > 0) {
            cli.print("\n{s} -> {s} updated: {d} marker(s) could not be resolved and were left as written{s}.\n", .{
                try cli.display(file),
                try cli.display(out_option),
                failed,
                skip_note,
            });
            return FAILED;
        }
        cli.print("\n{s} -> {s} {s}{s}.\n", .{
            try cli.display(file),
            try cli.display(out_option),
            if (changed) "updated" else "already up to date",
            skip_note,
        });
        return OK;
    }

    if (options.check) {
        if (stale > 0 or failed > 0) {
            if (stale > 0) {
                cli.printErr("\n{s} is stale: {d} of {d} block(s) differ from their files.\n", .{
                    try cli.display(file),
                    stale,
                    checked,
                });
            }
            if (failed > 0) {
                cli.printErr("{s}: {d} of {d} marker(s) could not be resolved and were left as written.\n", .{
                    try cli.display(file),
                    failed,
                    total,
                });
            }
            cli.printErr("Run: inject-examples {s}\n", .{try cli.display(file)});
            return FAILED;
        }
        if (skipped_count > 0) {
            cli.print("\n{s} is up to date: {d} checked, {d} skipped.\n", .{
                try cli.display(file),
                checked,
                skipped_count,
            });
        } else {
            cli.print("\n{s} matches all {d} marker(s).\n", .{ try cli.display(file), total });
        }
        return OK;
    }

    if (options.dry_run) {
        if (stale > 0) {
            cli.print("\n{s} would update {d} of {d} block(s){s}{s}.\n", .{
                try cli.display(file),
                stale,
                checked,
                skip_note,
                failed_note,
            });
        } else {
            cli.print("\n{s} already up to date{s}{s}.\n", .{
                try cli.display(file),
                skip_note,
                failed_note,
            });
        }
        return if (failed > 0) FAILED else OK;
    }

    if (result.changed) {
        const bytes = try inject.utf8Encode(alloc, result.text);
        Io.Dir.cwd().writeFile(cli.io, .{ .sub_path = file, .data = bytes }) catch |err| {
            const reason = try cli.reasonText(err, .writing, file);
            return failure.set(try inject.utf8Decode(alloc, reason));
        };
    }
    if (failed > 0) {
        cli.print("\n{s}: {d} updated, {d} failed{s}.\n", .{
            try cli.display(file),
            stale,
            failed,
            skip_note,
        });
        return FAILED;
    }
    cli.print("\n{s} {s}{s}.\n", .{
        try cli.display(file),
        if (result.changed) "updated" else "already up to date",
        skip_note,
    });
    return OK;
}

/// `normalize(current) !== normalize(result.text)`, on the two decoded texts.
fn normalizedEqual(alloc: Allocator, current: []const u8, text: Str) !bool {
    const decoded = try inject.utf8Decode(alloc, current);
    const left = try inject.normalize(alloc, decoded);
    const right = try inject.normalize(alloc, text);
    return inject.eql(left, right);
}

pub fn main(init: std.process.Init) !void {
    const alloc = init.arena.allocator();

    var cli = Cli{ .alloc = alloc, .io = init.io };
    cli.start();

    const argv = try init.minimal.args.toSlice(alloc);
    // node's `process.argv.slice(2)`; here argv[0] is this executable.
    const user_args = if (argv.len > 0) argv[1..] else argv[0..0];

    var failure = Failure{};
    const code = run(&cli, user_args, &failure) catch |err| switch (err) {
        error.Failed => blk: {
            cli.printErr("inject-examples: ", .{});
            cli.printErrUnits(failure.message);
            cli.printErr("\n", .{});
            break :blk FAILED;
        },
        else => blk: {
            cli.printErr("inject-examples: {s}\n", .{@errorName(err)});
            break :blk FAILED;
        },
    };

    cli.flush();
    std.process.exit(code);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test "parseArgs reads options and positionals" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const parsed = try parseArgs(alloc, &.{ "docs/G.md", "-g", "ci.txt" });
    try std.testing.expectEqualStrings("ci.txt", parsed.ok.gitignore_file.?);
    try std.testing.expectEqualStrings("docs/G.md", parsed.ok.files[0]);

    const split = try parseArgs(alloc, &.{ "--gitignore=ci.txt", "f.md" });
    try std.testing.expectEqualStrings("ci.txt", split.ok.gitignore_file.?);

    const off = try parseArgs(alloc, &.{"--no-gitignore"});
    try std.testing.expect(off.ok.no_gitignore);

    const conflict = try parseArgs(alloc, &.{ "-g", "a.txt", "--no-gitignore" });
    try std.testing.expectEqualStrings(
        "--gitignore and --no-gitignore cannot be used together",
        conflict.usage,
    );

    const unknown = try parseArgs(alloc, &.{"--bogus"});
    try std.testing.expectEqualStrings("unknown option: --bogus", unknown.usage);

    const missing = try parseArgs(alloc, &.{"--out"});
    try std.testing.expectEqualStrings("--out needs a value", missing.usage);

    const empty = try parseArgs(alloc, &.{});
    try std.testing.expectEqualStrings("README.md", empty.ok.files[0]);

    const after_dash = try parseArgs(alloc, &.{ "--", "-weird-name.md" });
    try std.testing.expectEqualStrings("-weird-name.md", after_dash.ok.files[0]);
}

test "HELP is the template with its placeholders filled in" {
    // The JavaScript HELP is a template literal; these are the only two
    // substitutions in it, and `--help` prints the result verbatim.
    try std.testing.expect(std.mem.indexOf(u8, HELP, "${") == null);
    try std.testing.expect(std.mem.endsWith(u8, HELP, "exits with the worst code it saw.\n"));
    try std.testing.expect(std.mem.startsWith(u8, HELP, "inject-examples "));
}
