/**
 * File-section matching — the Java implementation of {@code doc/section-matching.md}.
 *
 * <p>A {@code #<section-reference>} names a span of text inside a file: a declaration, a body, an
 * anchor, an {@code if} clause, or one nested inside another, written as a {@code /}-separated path
 * with an optional trailing modifier. The specification is {@code doc/section-matching.md} and the
 * authoritative implementation is {@code lib/section.mjs}; a port that disagrees with it is wrong by
 * definition, so the conformance vectors in {@code test/vectors/section-vectors.json} are the gate.
 *
 * <p>Like its JavaScript counterpart this library is <b>pure</b>: text in, text out, no filesystem,
 * no environment, no editor types. Every entry point takes a {@link java.lang.String} and returns a
 * value or throws; the caller owns all I/O. That is what lets it be vendored — or, here, be one
 * implementation example among several.
 *
 * <p>The entry point today is {@link hr.hrg.inject.section.SectionReference#parse(String)}: the
 * reference grammar, canonicalisation, the error text and the contradiction warning. The mask pass,
 * the block scanner and resolution are still to come; see the module README for the current state.
 */
package hr.hrg.inject.section;
