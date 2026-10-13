// A template literal spans lines and hides braces: the `}` below is text, not
// the end of a block.
export class Cart {
    // The catalog is a region directive: the directive lines are never injected.
    // #region catalog
    static catalog = ['bolt', 'nut', 'washer'];
    // #endregion

    constructor() {
        this.items = [];
    }

    /** One line of the cart; `{item}` is a label, not a block. */
    @deprecated
    render() {
        return `cart (${this.items.length}): ${this.items.map((item) => `{${item}}`).join(', ')}`;
    }

    add(item) {
        this.items.push(item);
    }

    dispatch(methodName) {
        if (methodName == "count") {
            return this.items.length;
        }
        return null;
    }

    count() { //count
        return this.items.length;
    }
}
