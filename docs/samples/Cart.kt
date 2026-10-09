class Cart {
    /* Kotlin nests /* comments */, and a raw string hides a decoy: */
    val note = """fun decoy() {}"""

    fun add(item: String) {
        items.add(item)
    }
}
