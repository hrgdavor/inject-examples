package cart

// Add appends one item. The raw string below is not code: a name inside it is
// invisible to the matcher, which is what the Go lexer buys.
func Add(items []string, item string) []string {
	return append(items, item)
}

var banner = `package cart

func Decoy() {}
`
