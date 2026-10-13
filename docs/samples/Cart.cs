using System.Collections.Generic;

public class Cart
{
    // The catalog is a region directive: the directive lines are never injected.
    // #region catalog
    private static readonly string[] Catalog = { "bolt", "nut", "washer" };
    // #endregion

    private readonly List<string> items = new List<string>();

    // A verbatim string keeps its quotes, so the brace in here is text.
    private string label = @"cart ""}"" decoy";

    /// <summary>Add one item to the cart.</summary>
    public void Add(string item)
    {
        items.Add(item);
    }

    /// <summary>Run one named method.</summary>
    public int Dispatch(string methodName)
    {
        if (methodName == "count")
        {
            return items.Count;
        }
        else if (methodName == "clear")
        {
            items.Clear();
            return 0;
        }
        return -1;
    }

    // The old name, kept as a comment anchor: `Legacy/count` names this block.
    public void Legacy() //count
    {
        System.Console.WriteLine(items.Count);
    }
}
