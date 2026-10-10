//! The lexical parity gate: what each language masks, and what each language's
//! declaration shapes report.
//!
//! `test/vectors/section-vectors.json` pins *resolution*, and can only do that
//! through the fixtures it names — six of the eighteen lexer entries. It
//! therefore says nothing about the shape layer on its own: a matcher that reads
//! `publisher: String,` as the field `lisher`, or that finds no declaration in
//! `impl<T: Clone> Display for Cart<T> {`, still passes every resolution vector,
//! because no fixture contains those lines.
//!
//! `test/vectors/lexical-vectors.json` is generated from the JavaScript by
//! `tools/lexical-vectors.mjs` and closes both holes: one mask row per lexer
//! entry (plus the built-in engine for an unknown type), and one shape row per
//! discriminating spelling.
//!
//! The gate is a mirror, not a vote: `plans/zig-port.md` §2 makes the JavaScript
//! the source of truth, so a row that disagrees is a bug here.

use inject_sections::lexer::{DefaultLexer, Lexer};
use inject_sections::syntaxes::lexer_for_path;
use serde_json::Value;

/// The corpus, as parsed JSON. The file lives with the JavaScript suite, so the
/// path is relative to the crate (`rust/section/`).
fn corpus() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/vectors/lexical-vectors.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
    serde_json::from_str(&text).expect("lexical-vectors.json is an object")
}

/// The lexer a mask row names: by extension, or the built-in engine for an
/// unknown type — the same choice `index.mjs` makes.
fn lexer_for(path: Option<&str>) -> Box<dyn Lexer> {
    match path {
        Some(path) => lexer_for_path(path),
        None => Box::new(DefaultLexer),
    }
}

/// JavaScript counts UTF-16 code units, and the port's contract is to agree with
/// it, so a length comparison must count the same thing.
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn describe(
    kind: &str,
    name: &str,
    header_from: usize,
    body: Option<&str>,
    end: Option<&str>,
    line: bool,
) -> String {
    format!("{kind}/{name} headerFrom={header_from} body={body:?} end={end:?} line={line}")
}

#[test]
fn every_mask_matches_this_implementation() {
    let corpus = corpus();
    let masks = corpus["masks"].as_array().expect("masks is an array");
    let mut failures: Vec<String> = Vec::new();
    let mut asserted = 0;

    for vector in masks {
        let name = vector["name"].as_str().unwrap_or("<unnamed>");
        let source = vector["source"].as_str().unwrap_or("");
        let expected = vector["masked"].as_str().unwrap_or("");
        asserted += 1;

        let masked = match lexer_for(vector["path"].as_str()).mask(source) {
            Ok(masked) => masked,
            Err(error) => {
                failures.push(format!("{name}: mask failed with {error:?}"));
                continue;
            }
        };

        if masked != expected {
            failures.push(format!("{name}: mask {masked:?}, want {expected:?}"));
        }
        // A mask is only useful if it *is* a mask: same length, and every
        // newline still at its own offset, so a declaration's body can neither
        // end early nor run past its line.
        if utf16_len(&masked) != utf16_len(source) {
            failures.push(format!(
                "{name}: the mask changed the length, {} for {}",
                utf16_len(&masked),
                utf16_len(source)
            ));
        }
        let units: Vec<u16> = masked.encode_utf16().collect();
        let source_units: Vec<u16> = source.encode_utf16().collect();
        if let Some(at) = source_units
            .iter()
            .enumerate()
            .position(|(i, unit)| *unit == b'\n' as u16 && units.get(i) != Some(&(b'\n' as u16)))
        {
            failures.push(format!("{name}: the mask moved the newline at {at}"));
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {asserted} masks disagree with lib/section.mjs:\n  {}",
        failures.len(),
        failures.join("\n  ")
    );
    assert_eq!(asserted, masks.len(), "every mask vector must be asserted");
    println!("masks: {asserted} asserted, all matching lib/section.mjs");
}

#[test]
fn every_declaration_shape_matches_this_implementation() {
    let corpus = corpus();
    let shapes = corpus["shapes"].as_array().expect("shapes is an array");
    let mut failures: Vec<String> = Vec::new();
    let mut asserted = 0;

    for vector in shapes {
        let name = vector["name"].as_str().unwrap_or("<unnamed>");
        let line = vector["line"].as_str().unwrap_or("");
        let expected = vector["declared"].as_array().expect("declared is an array");
        asserted += 1;

        let lexer = lexer_for(Some(vector["path"].as_str().unwrap_or("")));
        let declared = lexer.declarations(line);

        if declared.len() != expected.len() {
            failures.push(format!(
                "{name} ({line:?}): {} declaration(s), want {}",
                declared.len(),
                expected.len()
            ));
            continue;
        }
        for (index, (got, want)) in declared.iter().zip(expected).enumerate() {
            let got = describe(
                &got.kind,
                &got.name,
                got.header_from,
                got.body.as_deref(),
                got.end.as_deref(),
                got.line,
            );
            let want = describe(
                want["kind"].as_str().unwrap_or(""),
                want["name"].as_str().unwrap_or(""),
                want["headerFrom"].as_u64().unwrap_or(0) as usize,
                want["body"].as_str(),
                want["end"].as_str(),
                want["line"].as_bool().unwrap_or(false),
            );
            if got != want {
                failures.push(format!(
                    "{name} ({line:?}): [{index}] got {got}, want {want}"
                ));
            }
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {asserted} shapes disagree with lib/section.mjs:\n  {}",
        failures.len(),
        failures.join("\n  ")
    );
    assert_eq!(
        asserted,
        shapes.len(),
        "every shape vector must be asserted"
    );
    println!("shapes: {asserted} asserted, all matching lib/section.mjs");
}
