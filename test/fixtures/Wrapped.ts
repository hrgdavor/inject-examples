export class Wrapped {
    render(
        name: string,
        quantity: number,
    ): string {
        return `${name} x${quantity}`;
    }

    add(
        item: string,
    ): void {
        this.items.push(item);
    }
}
