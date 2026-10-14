package demo;

/**
 * Enum spellings that put more than one constant on a line. Each constant is still a member, so a link can name
 * it — and a body written on one line is a container, because what it contains is its constants.
 */
public enum Bunched {
    CALL, CHAT, CHAT_AUDIO
}

enum WithBodies { FREE(0), PAID(1) { int rank() { return 1; } } }
