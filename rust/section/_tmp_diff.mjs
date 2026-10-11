// TEMPORARY differential harness (deleted before the task ends): run the JavaScript reference over
// a case list and write its answers, so the Rust port can be compared against them.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { planSection } from '../../lib/section.mjs';
import { lexerFor } from '../../src/js/scanner/lexers.js';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const fixturesDir = `${here}../../test/fixtures`;

/** Every identifier-looking token in a source, deduplicated, in first-seen order. */
function tokens(source) {
    const seen = new Set();
    for (const match of source.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) seen.add(match[0]);
    return [...seen];
}

const cases = [];
for (const name of readdirSync(fixturesDir)) {
    const source = readFileSync(`${fixturesDir}/${name}`, 'utf8');
    for (const token of tokens(source)) {
        cases.push({ path: name, source, reference: token });
        cases.push({ path: name, source, reference: `${token}-` });
        cases.push({ path: name, source, reference: `${token}+` });
    }
}

// Crafted sources for the declaration-header and shape rules, one entry per spelling.
const crafted = [
    ['T.rs', 'impl Cart {\n    pub fn add(&self, item: String) {\n        self.items.push(item);\n    }\n}\n'],
    ['T.rs', 'impl Cart {\n}\n'],
    ['T.rs', 'impl Cart {\n    // a leading anchor\n    pub fn add(&self) {}\n}\n'],
    ['T.rs', 'impl<T: Clone> Display for Cart<T> {\n    fn fmt(&self, f: &mut Formatter) -> std::fmt::Result {\n        write!(f, "Cart")\n    }\n}\n'],
    ['T.rs', 'struct Cart {\n    items: Vec<String>,\n}\n'],
    ['T.rs', 'struct Cart {\n}\n'],
    ['T.rs', 'pub struct Cart {\n    pub name: String,\n}\n'],
    ['T.rs', 'const MAX: usize = 10;\n'],
    ['T.rs', 'const PICK: fn(i32) -> i32 = |a| a + 1;\n'],
    ['T.rs', 'fn pick(a: i32) -> i32 {\n    a + 1\n}\n'],
    ['T.rs', 'fn remove(&mut self) -> Option<String> {\n    self.items.pop()\n}\n'],
    ['T.rs', 'fn\n    remove(&mut self)\n    -> Option<String> {\n    self.items.pop()\n}\n'],
    ['T.rs', 'mod inner {\n    pub fn go() {}\n}\n'],
    ['T.rs', 'impl Cart {\n    fn a(&self) -> u8 { 1 }\n    fn b(&self) -> u8 { 2 }\n}\n'],
    ['T.hs', 'add x y = x + y\n'],
    ['T.hs', 'add x y = do\n    print x\n    print y\n'],
    ["T.hs", "add' x = 1\n"],
    ['T.hs', 'store = Store { name = "x" }\n'],
    ['T.hs', 'module M where\n\nadd x y = x + y\n\nsub x = x - 1\n'],
    ['T.hs', 'class Monad m => Render m where\n    render :: m -> String\n'],
    ['T.hs', 'render :: String -> String\nrender s = s\n'],
    ['T.js', 'const add = (a, b) => a + b;\n'],
    ['T.js', 'const add = (a, b) => {\n    return a + b;\n};\n'],
    ['T.js', 'function add(a, b) {\n    return a + b;\n}\n'],
    ['T.js', 'class Cart {\n    add(item) {\n        return item;\n    }\n}\n'],
    ['T.js', 'const svc = {\n    add(a) {\n        return a;\n    },\n};\n'],
    ['T.ts', 'const add = (a: number, b: number): number => a + b;\n'],
    ['T.ts', 'function add(\n    a: number,\n    b: number,\n): number {\n    return a + b;\n}\n'],
    ['T.java', 'class Cart {\n    void add(int x) {\n        this.x = x;\n    }\n}\n'],
    ['T.java', 'interface I {\n    void bar(\n            int x);\n    void baz() {\n        work();\n    }\n}\n'],
    ['T.java', 'abstract class A {\n    abstract void run();\n}\n'],
    ['T.java', 'enum E {\n    A,\n    B;\n}\n'],
    ['T.rb', 'class Cart\n  def add(x)\n    @items << x\n  end\nend\n'],
    ['T.rb', 'def add(x)\n  items.each do |i|\n    puts i\n  end\nend\n'],
    ['T.vb', 'Class Form\n    Sub Add(x As Integer)\n        Me.X = x\n    End Sub\nEnd Class\n'],
    ['T.py', 'def add(a, b):\n    return a + b\n'],
    ['T.py', 'class Cart:\n    def add(self, x):\n        self.x = x\n'],
    ['T.go', 'func (r *Repo) Find(id int) (*Item, error) {\n\treturn nil, nil\n}\n'],
    ['T.go', 'func main() {\n\tfmt.Println("hi")\n}\n'],
    ['T.kt', 'class Cart {\n    fun add(x: Int) {\n        this.x = x\n    }\n}\n'],
    ['T.cs', 'class Cart {\n    public void Add(int x) {\n        this.x = x;\n    }\n}\n'],
    ['T.zig', 'pub fn add(a: u8, b: u8) u8 {\n    return a + b;\n}\n'],
    ['T.php', 'class Cart {\n    public function add($x) {\n        return $x;\n    }\n}\n'],
    ['T.sql', 'SELECT id, name\nFROM cart\nWHERE id = 1;\n'],
    ['T.toml', '[cart]\nname = "x"\n'],
    ['T.yaml', 'cart:\n  name: x\n'],
    ['T.ini', '[cart]\nname = x\n'],
    ['T.json', '{\n  "cart": {\n    "name": "x"\n  }\n}\n'],
    ['T.md', '# Title\n\n## cart\n\nbody\n'],
    ['T.unknown', 'impl Cart {\n}\n'],
];
for (const [path, source] of crafted) {
    for (const token of tokens(source)) {
        cases.push({ path, source, reference: token });
        cases.push({ path, source, reference: `${token}-` });
        cases.push({ path, source, reference: `${token}+` });
    }
}

const answers = cases.map(({ path, source, reference }) => {
    try {
        const plan = planSection(source, reference, lexerFor(path));
        return {
            text: plan.text,
            kind: plan.kind,
            startLine: plan.startLine,
            endLine: plan.endLine,
            ranges: plan.ranges.map((r) => [r.from, r.to]),
        };
    } catch (error) {
        return { error: String(error.message ?? error) };
    }
});

writeFileSync(`${here}_tmp_cases.json`, JSON.stringify(cases));
writeFileSync(`${here}_tmp_ref.json`, JSON.stringify(answers));
console.log(`cases: ${cases.length}`);
