//! The block tree: what a scan produces, and the two index-building rules.
//!
//! The Java port threads a parent/scope **pointer graph** through mutable objects. Rust's ownership
//! forbids that, so a block is `Rc<RefCell<Block>>` with `Weak` up-pointers: the same shape, same
//! walking order, and no arena to thread indices through. A scan is short-lived, so `Rc` is also the
//! cheapest thing that works here.
//!
//! Offsets are UTF-16 code-unit offsets, as everywhere in this port.

use std::cell::RefCell;
use std::rc::{Rc, Weak};

use crate::lexer::Conditions;
use crate::mask::{from_units, line_of, units, Comment};
use crate::matchers::{anchor_name, is_region_line, region_directive, DirectiveKind};
use crate::span::{next_non_blank_units, trim_units, Span};

/// A block: a class-like body, a method body, a statement body, a property, or the file itself.
#[derive(Debug)]
pub struct Block {
    pub kind: String,
    pub name: Option<String>,
    pub decl_line: usize,
    pub open: Option<usize>,
    pub close: Option<usize>,
    pub open_line: Option<usize>,
    pub close_line: Option<usize>,
    pub end_line: Option<usize>,
    pub expression: Option<usize>,
    pub line_end: Option<usize>,
    pub single_line: bool,
    pub shared_close: bool,
    pub indented: bool,
    pub children: Vec<BlockRef>,
    /// Every block declared directly in this one, for a caller that wants the flat list.
    pub blocks: Vec<BlockRef>,
    pub regions: Vec<Region>,
    pub anchor: Option<Anchor>,
    pub conditions: Option<Conditions>,
    pub parent: Weak<RefCell<Block>>,
    pub scope: Weak<RefCell<Block>>,
    pub scope_name: Option<String>,
    pub scope_line: Option<usize>,
}

/// A shared block, as the scanner and the resolver pass it around.
pub type BlockRef = Rc<RefCell<Block>>;

impl Block {
    /// The root of a scan: the file itself, in scope 0.
    pub fn root() -> BlockRef {
        Rc::new(RefCell::new(Block {
            kind: "root".to_string(),
            name: None,
            decl_line: 0,
            open: None,
            close: None,
            open_line: None,
            close_line: None,
            end_line: None,
            expression: None,
            line_end: None,
            single_line: false,
            shared_close: false,
            indented: false,
            children: Vec::new(),
            blocks: Vec::new(),
            regions: Vec::new(),
            anchor: None,
            conditions: None,
            parent: Weak::new(),
            scope: Weak::new(),
            scope_name: None,
            scope_line: None,
        }))
    }

    /// A block the scanner is about to fill in.
    pub fn new(kind: &str, name: Option<&str>, decl_line: usize) -> BlockRef {
        let root = Block::root();
        {
            let mut block = root.borrow_mut();
            block.kind = kind.to_string();
            block.name = name.map(str::to_string);
            block.decl_line = decl_line;
        }
        root
    }

    /// The last line the block covers, for a walker.
    pub fn last_line(&self) -> usize {
        self.end_line.unwrap_or(self.decl_line)
    }
}

/// A paired `#region … #endregion`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Region {
    pub name: String,
    pub start_line: usize,
    pub end_line: usize,
    /// The line the resolver reports: the region's own first line, as `index.mjs` does.
    pub line: usize,
    pub kind: String,
}

/// A comment anchor: the comment that is the first thing inside a block's braces.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub name: String,
    pub line: usize,
}

/// What one scan produced.
#[derive(Clone, Debug)]
pub struct Scan {
    pub root: BlockRef,
    pub blocks: Vec<BlockRef>,
    pub regions: Vec<Region>,
    pub anchors: Vec<Anchor>,
}

/// Fill a block in from a span, as `applySpan` does.
pub fn apply_span(block: &BlockRef, span: &Span) {
    let mut block = block.borrow_mut();
    if span.indented {
        block.indented = true;
        block.close_line = span.body_end_line;
        block.end_line = span.body_end_line;
        return;
    }
    if let Some(expression) = span.expression {
        block.expression = Some(expression);
        block.end_line = Some(block.decl_line);
        return;
    }
    block.open = span.open;
    block.close = span.close;
    block.open_line = span.open_line;
    block.close_line = span.close_line;
    block.end_line = span.close_line;
}

/// Pair the `#region`/`#endregion` directives of a source, innermost first when they nest.
pub fn pair_regions(mask_lines: &[Vec<u16>]) -> Vec<Region> {
    let mut out = Vec::new();
    let mut stack: Vec<(String, usize)> = Vec::new();
    for (index, line) in mask_lines.iter().enumerate() {
        let Some(directive) = region_directive(&from_units(line)) else {
            continue;
        };
        match directive.kind {
            DirectiveKind::Region => stack.push((directive.name, index)),
            DirectiveKind::EndRegion => {
                if let Some((name, start_line)) = stack.pop() {
                    out.push(Region {
                        name,
                        start_line,
                        end_line: index,
                        line: start_line,
                        kind: "region".to_string(),
                    });
                }
            }
        }
    }
    out
}

/// The leading-comment anchor of a braced block, or `None`: the comment that is the first thing inside
/// the braces. A `#region`/`#endregion` line is never an anchor, and a body whose first thing is code has
/// no anchor at all.
pub fn leading_anchor(
    comments: &[Comment],
    source: &[u16],
    lines: &[Vec<u16>],
    starts: &[usize],
    open: usize,
) -> Option<Anchor> {
    let mut first: Option<&Comment> = None;
    for comment in comments {
        if comment.from <= open {
            continue;
        }
        if trim_units(&source[open + 1..comment.from]).is_empty() {
            first = Some(comment);
        }
        break;
    }
    let first = first?;

    let comment_line = line_of(starts, first.from);
    let brace_line = line_of(starts, open);
    if comment_line != brace_line
        && Some(comment_line) != next_non_blank_units(lines, brace_line + 1)
    {
        return None;
    }

    let body = first.text.trim();
    if is_region_line(body) {
        return None;
    }
    Some(Anchor { name: anchor_name(body)?.to_string(), line: comment_line })
}

/// The unit lines of a source, for a caller that has the text but not yet the split.
pub fn lines_of(source: &str) -> Vec<Vec<u16>> {
    source.split('\n').map(units).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mask::comments_in;

    #[test]
    fn a_tree_keeps_its_up_pointers() {
        let root = Block::root();
        let class = Block::new("class", Some("Cart"), 0);
        let method = Block::new("method", Some("add"), 2);

        class.borrow_mut().parent = Rc::downgrade(&root);
        class.borrow_mut().scope = Rc::downgrade(&root);
        method.borrow_mut().parent = Rc::downgrade(&class);
        method.borrow_mut().scope = Rc::downgrade(&class);
        root.borrow_mut().children.push(class.clone());
        class.borrow_mut().children.push(method.clone());

        assert_eq!("root", root.borrow().kind);
        // A class's scope is the file; the method's scope is the class.
        assert_eq!("root", class.borrow().scope.upgrade().unwrap().borrow().kind);
        let parent = method.borrow().parent.upgrade().unwrap();
        assert_eq!(Some("Cart"), parent.borrow().name.clone().as_deref());
        assert_eq!("Cart", method.borrow().scope.upgrade().unwrap().borrow().name.clone().unwrap());
        assert_eq!(1, root.borrow().children.len());
    }

    #[test]
    fn spans_fill_a_block_in() {
        let block = Block::new("method", Some("add"), 3);
        apply_span(&block, &Span { open: Some(10), close: Some(30), open_line: Some(3), close_line: Some(5), ..Span::default() });
        assert_eq!(Some(5), block.borrow().end_line);
        assert_eq!(Some(10), block.borrow().open);

        // An indented body has no braces: the end line is what carries the selection.
        let indented = Block::new("method", Some("add"), 1);
        apply_span(&indented, &Span { indented: true, body_end_line: Some(4), ..Span::default() });
        assert!(indented.borrow().indented);
        assert_eq!(Some(4), indented.borrow().end_line);
        assert_eq!(None, indented.borrow().open);
    }

    #[test]
    fn regions_pair_innermost_with_the_first_unclosed_directive() {
        let source = "a\n#region outer\nb\n  #endregion\nc\n// #region inner\nd\n// #endregion\ne\n";
        let regions = pair_regions(&lines_of(source));
        assert_eq!(2, regions.len());
        assert_eq!(("outer".to_string(), 1, 3), (regions[0].name.clone(), regions[0].start_line, regions[0].end_line));
        assert_eq!(("inner".to_string(), 5, 7), (regions[1].name.clone(), regions[1].start_line, regions[1].end_line));

        // An unclosed directive is not a region at all: the library pairs them.
        assert!(pair_regions(&lines_of("#region lonely\ncontent\n")).is_empty());
    }

    #[test]
    fn an_anchor_is_the_first_thing_in_the_braces() {
        let source = "    public void handler() { //getUsers\n        work();\n    }\n";
        let lines = lines_of(source);
        let starts = crate::mask::line_starts(&units(source));
        let source_units = units(source);
        let comments = comments_in(source);
        let open = source.find('{').unwrap();
        let anchor = leading_anchor(&comments, &source_units, &lines, &starts, open).unwrap();
        assert_eq!(("getUsers".to_string(), 0), (anchor.name.clone(), anchor.line));

        // A comment that is not the first thing inside the braces is not an anchor.
        let later = "    public void handler() {\n        work(); //getUsers\n    }\n";
        let later_lines = lines_of(later);
        let later_starts = crate::mask::line_starts(&units(later));
        let later_units = units(later);
        let later_comments = comments_in(later);
        let later_open = later.find('{').unwrap();
        assert!(leading_anchor(&later_comments, &later_units, &later_lines, &later_starts, later_open).is_none());
    }

    #[test]
    fn a_region_line_is_never_an_anchor() {
        let source = "    public void handler() { // #region wiring\n        work();\n    }\n";
        let lines = lines_of(source);
        let starts = crate::mask::line_starts(&units(source));
        let source_units = units(source);
        let comments = comments_in(source);
        let open = source.find('{').unwrap();
        assert!(leading_anchor(&comments, &source_units, &lines, &starts, open).is_none());
    }
}
