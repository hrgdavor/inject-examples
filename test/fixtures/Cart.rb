class Cart
  def add(item)
    @items << item
  end

  def self.build
    new
  end
end
