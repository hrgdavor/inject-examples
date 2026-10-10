module Prime where

add' :: Int -> Int
add' x = x + 1

data Foo' = Foo' Int

double :: Int -> Int
double x = go x
  where
    go y = y * 2

class Store s where
  get :: s -> Int
