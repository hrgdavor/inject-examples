// A template literal spans lines and hides braces: the `}` below is text, not
// the end of a block.
export class Cart {
    constructor() {
        this.items = [];
    }

    /** One line of the cart; `{item}` is a label, not a block. */
    render() {
        return `cart (${this.items.length}): ${this.items.map((item) => `{${item}}`).join(', ')}`;
    }

    add(item) {
        this.items.push(item);
    }
}
