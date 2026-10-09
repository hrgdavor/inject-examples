using System.Collections.Generic;

public class Cart
{
    private readonly List<string> items = new List<string>();

    // A verbatim string keeps its quotes, so the brace in here is text.
    private string label = @"cart ""}"" decoy";

    public void Add(string item)
    {
        items.Add(item);
    }
}
