package demo

func Add(
	items []string,
	item string,
) []string {
	return append(items, item)
}

func Plain(items []string) int {
	return len(items)
}
