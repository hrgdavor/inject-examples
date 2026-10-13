package cart

// The catalog is a region directive: the directive lines are never injected.
// #region catalog
var Catalog = []string{"bolt", "nut", "washer"}
// #endregion

// Add appends one item. The raw string below is not code: a name inside it is
// invisible to the matcher, which is what the Go lexer buys.
func Add(items []string, item string) []string {
	return append(items, item)
}

// Dispatch runs the method the name asks for. A `case` arm is an arm and not a
// block, so the literal is named by the switch's own line.
func Dispatch(methodName string) int {
	switch "count" {
	case methodName:
		return len(Catalog)
	}
	return -1
}

func Legacy() { //count
	println(len(Catalog))
}

var banner = `package cart

func Decoy() {}
`
