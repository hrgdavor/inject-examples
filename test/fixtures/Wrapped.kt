package demo

class Wrapped {
    fun render(
        name: String,
        quantity: Int
    ): String {
        return "$name x$quantity"
    }

    fun label(
        upper: Boolean
    ): String = if (upper) name.uppercase() else name
}
