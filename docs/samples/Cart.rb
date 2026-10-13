class Cart
  # The catalog is a region directive: the directive lines are never injected.
  # #region catalog
  CATALOG = %w[bolt nut washer].freeze
  # #endregion

  # A name may end in `!` or `?`: part of the name, not a modifier.
  def add!(item)
    @items << item
  end

  def add(item)
    @items << item
  end

  # count is answered by the if that names it.
  def dispatch(method_name)
    if method_name == "count"
      @items.size
    elsif method_name == "clear"
      @items.clear
      0
    end
  end

  def legacy # count
    @items.size
  end

  def self.build
    new
  end
end
